import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, threadId } from "node:worker_threads";
import { withFilesystemLock } from "./filesystem_lock.mjs";
import {
  abandonInvalidSharedDisconnectTransaction,
  listSharedDisconnectRecoveryIssues,
  peekSharedDisconnectRecoveryIssues,
  readSharedConnectionReceipt,
  recoverSharedContextTransactions,
  removeOrphanedSharedContextBindings,
  sharedContextStatus,
} from "./shared_context.mjs";

export const CONTEXT_HUB_REGISTRY_VERSION = 5;
export const CONTEXT_HUB_SNAPSHOT_VERSION = 3;
export const CONTEXT_HUB_ATTENTION_VERSION = 1;
const LEGACY_REGISTRY_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const MAX_CONTEXT_HUB_PROJECT_CONTROL_FILE_BYTES = 2_097_152;

function hubHome() {
  return process.env.CONTEXT_ROOM_HUB_HOME
    ? path.resolve(process.env.CONTEXT_ROOM_HUB_HOME)
    : path.join(process.env.HOME || os.homedir(), ".context-room", "hub");
}

export function contextHubHostRoot() {
  return path.join(hubHome(), "host");
}

function registryPath() {
  return path.join(hubHome(), "registry.json");
}

export function contextHubRegistryLockPath() {
  return path.join(hubHome(), "registry.lock");
}

function registryLockPath() {
  return contextHubRegistryLockPath();
}

function snapshotControlPath() {
  return path.join(hubHome(), "snapshot-control.json");
}

function runtimePath() {
  return path.join(hubHome(), "runtime.json");
}

export function contextHubSnapshotPath() {
  return path.join(hubHome(), "snapshot.json");
}

export function contextHubAttentionPath() {
  return path.join(hubHome(), "attention.json");
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
    const directoryDescriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  fs.chmodSync(filePath, 0o600);
  return value;
}

const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
// The owner record includes a process-generation identity. A short grace keeps
// a SIGKILL between a durable registry write and journal cleanup recoverable on
// the next request instead of making the Hub unavailable for half a minute.
const REGISTRY_LOCK_STALE_MS = 1_000;
let registryLockDepth = 0;

function withRegistryLock(operation, { recoverSharedTransactions = true } = {}) {
  if (registryLockDepth > 0) return operation();
  return withFilesystemLock(registryLockPath(), () => {
    registryLockDepth += 1;
    try {
      recoverInvalidHubSharedQuarantineStagingLocked();
      if (recoverSharedTransactions) recoverContextHubSharedTransactionsLocked({ tolerateConflicts: true });
      return operation();
    } finally {
      registryLockDepth -= 1;
    }
  }, {
    timeoutMs: REGISTRY_LOCK_TIMEOUT_MS,
    staleMs: REGISTRY_LOCK_STALE_MS,
    busyMessage: "Context Hub registry is busy in another process",
    busyCode: "context_hub_registry_busy",
  });
}

function normalizedSnapshotControl(raw = {}) {
  return {
    version: 1,
    invalidationRevision: String(raw.invalidationRevision || "initial"),
    refreshSequence: Math.max(0, Number.parseInt(raw.refreshSequence, 10) || 0),
  };
}

function readSnapshotControl() {
  try {
    return normalizedSnapshotControl(readJson(snapshotControlPath(), {}));
  } catch {
    return normalizedSnapshotControl();
  }
}

function writeSnapshotControl(control) {
  return writeJson(snapshotControlPath(), normalizedSnapshotControl(control));
}

function invalidateContextHubSnapshotLocked({ preserveState = false } = {}) {
  const snapshotPath = contextHubSnapshotPath();
  let snapshot = null;
  if (preserveState) {
    try { snapshot = readJson(snapshotPath, null); } catch {}
  }
  const control = readSnapshotControl();
  const registryRevision = contextHubRegistryRevision();
  const canPreserve = snapshot?.state
    && typeof snapshot.state === "object"
    && Number(snapshot.version) === CONTEXT_HUB_SNAPSHOT_VERSION
    && snapshot.registryRevision === registryRevision
    && snapshot.invalidationRevision === control.invalidationRevision;
  control.invalidationRevision = randomUUID();
  writeSnapshotControl(control);
  if (canPreserve) {
    writeJson(snapshotPath, {
      version: CONTEXT_HUB_SNAPSHOT_VERSION,
      registryRevision,
      invalidationRevision: control.invalidationRevision,
      refreshSequence: control.refreshSequence,
      generatedAt: "1970-01-01T00:00:00.000Z",
      state: snapshot.state,
    });
    return;
  }
  try { fs.unlinkSync(contextHubSnapshotPath()); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function invalidateContextHubSnapshot(options = {}) {
  return withRegistryLock(() => invalidateContextHubSnapshotLocked(options));
}

function mutateContextHubRegistry(operation) {
  return withRegistryLock(() => {
    const registry = readContextHubRegistry();
    const result = operation(registry);
    writeJson(registryPath(), registry);
    invalidateContextHubSnapshotLocked();
    return result;
  });
}

function cleanAttentionId(value) {
  const id = String(value || "").trim();
  return id && !/[\u0000\r\n]/.test(id) ? id.slice(0, 1000) : "";
}

function normalizedAttention(raw = {}) {
  const projectOrder = Array.isArray(raw.projectOrder)
    ? [...new Set(raw.projectOrder.map(cleanAttentionId).filter(Boolean))]
    : [];
  const snoozes = {};
  if (raw.snoozes && typeof raw.snoozes === "object" && !Array.isArray(raw.snoozes)) {
    for (const [key, entry] of Object.entries(raw.snoozes)) {
      const reviewId = cleanAttentionId(entry?.reviewId || key);
      const revisionToken = cleanAttentionId(entry?.revisionToken);
      const until = String(entry?.until || "");
      if (!reviewId || !revisionToken || !Number.isFinite(Date.parse(until))) continue;
      snoozes[reviewId] = {
        reviewId,
        revisionToken,
        until: new Date(until).toISOString(),
        createdAt: Number.isFinite(Date.parse(entry?.createdAt)) ? new Date(entry.createdAt).toISOString() : new Date().toISOString(),
      };
    }
  }
  return { version: CONTEXT_HUB_ATTENTION_VERSION, projectOrder, snoozes };
}

function attentionRevision(attention) {
  return createHash("sha256").update(JSON.stringify(normalizedAttention(attention))).digest("hex");
}

export function readContextHubAttention() {
  let raw = {};
  try { raw = readJson(contextHubAttentionPath(), {}); } catch { raw = {}; }
  const attention = normalizedAttention(raw);
  return { ...attention, revision: attentionRevision(attention) };
}

function writeContextHubAttentionPreferences(update, { expectedRevision = "" } = {}) {
  return withRegistryLock(() => {
    const current = readContextHubAttention();
    if (expectedRevision && expectedRevision !== current.revision) {
      const error = new Error("Context Hub attention settings changed in another workspace");
      error.statusCode = 409;
      error.code = "attention_revision_conflict";
      error.details = { expectedRevision, currentRevision: current.revision };
      throw error;
    }
    const attention = normalizedAttention(update(current));
    writeJson(contextHubAttentionPath(), attention);
    return { ...attention, revision: attentionRevision(attention) };
  });
}

export function setContextHubProjectOrder(projectOrder, { expectedRevision = "" } = {}) {
  return writeContextHubAttentionPreferences((current) => ({ ...current, projectOrder }), { expectedRevision });
}

export function setContextHubReviewSnoozes(entries = [], { expectedRevision = "" } = {}) {
  return writeContextHubAttentionPreferences((current) => {
    const snoozes = { ...current.snoozes };
    for (const entry of entries) {
      const reviewId = cleanAttentionId(entry?.reviewId);
      const revisionToken = cleanAttentionId(entry?.revisionToken);
      const until = String(entry?.until || "");
      if (!reviewId || !revisionToken || !Number.isFinite(Date.parse(until))) throw new Error("A review id, exact revision, and valid snooze deadline are required");
      snoozes[reviewId] = { reviewId, revisionToken, until: new Date(until).toISOString(), createdAt: new Date().toISOString() };
    }
    return { ...current, snoozes };
  }, { expectedRevision });
}

export function removeContextHubReviewSnoozes(reviewIds = [], { expectedRevision = "" } = {}) {
  return writeContextHubAttentionPreferences((current) => {
    const snoozes = { ...current.snoozes };
    for (const reviewId of reviewIds.map(cleanAttentionId).filter(Boolean)) delete snoozes[reviewId];
    return { ...current, snoozes };
  }, { expectedRevision });
}

function stableRoot(root) {
  const resolved = path.resolve(root);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function stableLocalRepositoryPath(repository) {
  const resolved = path.resolve(repository);
  let anchor = resolved;
  const suffix = [];
  while (true) {
    try {
      const canonicalAnchor = fs.realpathSync(anchor);
      return path.join(canonicalAnchor, ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(anchor);
      if (parent === anchor) return resolved;
      suffix.unshift(path.basename(anchor));
      anchor = parent;
    }
  }
}

function stableStoredProjectId(root) {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
}

function stableProjectId(root) {
  return stableStoredProjectId(stableRoot(root));
}

function normalizedProjectRootIdentity(value = null) {
  const dev = String(value?.dev || "").trim();
  const ino = String(value?.ino || "").trim();
  return dev && ino ? { dev, ino } : null;
}

function normalizedFilesystemEntryIdentity(value = null) {
  const dev = String(value?.dev || "");
  const ino = String(value?.ino || "");
  const mode = String(value?.mode || "");
  const kind = String(value?.kind || "");
  return /^\d+$/.test(dev) && /^\d+$/.test(ino) && /^\d+$/.test(mode) && ["file", "directory"].includes(kind)
    ? { dev, ino, mode, kind }
    : null;
}

function filesystemEntryIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  const kind = stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "";
  if (!kind || stats.isSymbolicLink()) throw new Error(`Unsupported filesystem entry identity: ${filePath}`);
  return { dev: stats.dev.toString(), ino: stats.ino.toString(), mode: stats.mode.toString(), kind };
}

function contextHubProjectRootIdentity(root) {
  const projectRoot = path.resolve(root);
  const stats = fs.lstatSync(projectRoot, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory() || fs.realpathSync(projectRoot) !== projectRoot) {
    throw contextHubProjectControlFileError(projectRoot, "project root identity changed or is now a symbolic link");
  }
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
}

function contextHubProjectRootMatchesIdentity(root, expected = null) {
  try {
    const current = contextHubProjectRootIdentity(root);
    const normalizedExpected = normalizedProjectRootIdentity(expected);
    return !normalizedExpected
      || (current.dev === normalizedExpected.dev && current.ino === normalizedExpected.ino);
  } catch {
    return false;
  }
}

function normalizedWorktreeMembershipIdentity(value = null) {
  const kind = String(value?.kind || "");
  if (kind === "path") return { kind: "path" };
  if (kind !== "git") return null;
  const commonDir = path.resolve(String(value?.commonDir || ""));
  const commonDirIdentity = normalizedProjectRootIdentity(value?.commonDirIdentity);
  const relativeRoot = String(value?.relativeRoot || "");
  if (!commonDirIdentity || !relativeRoot || path.isAbsolute(relativeRoot) || relativeRoot.split(/[\\/]+/).includes("..")) return null;
  const gitDir = value?.gitDir ? path.resolve(String(value.gitDir)) : "";
  const gitDirIdentity = normalizedProjectRootIdentity(value?.gitDirIdentity);
  const gitEntryIdentity = normalizedFilesystemEntryIdentity(value?.gitEntryIdentity);
  const anchored = Boolean(gitDir && gitDirIdentity && gitEntryIdentity);
  return {
    kind: "git",
    commonDir,
    commonDirIdentity,
    relativeRoot,
    ...(anchored ? { gitDir, gitDirIdentity, gitEntryIdentity } : {}),
  };
}

function worktreeMembershipIdentityIsAnchored(value) {
  const normalized = normalizedWorktreeMembershipIdentity(value);
  return normalized?.kind === "path" || Boolean(normalized?.gitDir && normalized?.gitDirIdentity && normalized?.gitEntryIdentity);
}

function sameWorktreeMembershipIdentity(left, right) {
  const normalizedLeft = normalizedWorktreeMembershipIdentity(left);
  const normalizedRight = normalizedWorktreeMembershipIdentity(right);
  if (!normalizedLeft || !normalizedRight || normalizedLeft.kind !== normalizedRight.kind) return false;
  if (normalizedLeft.kind === "path") return true;
  const baseMatches = normalizedLeft.commonDir === normalizedRight.commonDir
    && normalizedLeft.commonDirIdentity.dev === normalizedRight.commonDirIdentity.dev
    && normalizedLeft.commonDirIdentity.ino === normalizedRight.commonDirIdentity.ino
    && normalizedLeft.relativeRoot === normalizedRight.relativeRoot;
  if (!baseMatches) return false;
  const leftAnchored = worktreeMembershipIdentityIsAnchored(normalizedLeft);
  const rightAnchored = worktreeMembershipIdentityIsAnchored(normalizedRight);
  if (!leftAnchored && !rightAnchored) return true;
  return leftAnchored && rightAnchored
    && normalizedLeft.gitDir === normalizedRight.gitDir
    && normalizedLeft.gitDirIdentity.dev === normalizedRight.gitDirIdentity.dev
    && normalizedLeft.gitDirIdentity.ino === normalizedRight.gitDirIdentity.ino
    && normalizedLeft.gitEntryIdentity.dev === normalizedRight.gitEntryIdentity.dev
    && normalizedLeft.gitEntryIdentity.ino === normalizedRight.gitEntryIdentity.ino
    && normalizedLeft.gitEntryIdentity.mode === normalizedRight.gitEntryIdentity.mode
    && normalizedLeft.gitEntryIdentity.kind === normalizedRight.gitEntryIdentity.kind;
}

function gitText(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function gitWorktreeIdentity(root, previous = null) {
  const projectRoot = stableRoot(root);
  const gitRootValue = gitText(projectRoot, ["rev-parse", "--show-toplevel"]);
  const commonDirValue = gitText(projectRoot, ["rev-parse", "--git-common-dir"]);
  const gitDirValue = gitText(projectRoot, ["rev-parse", "--git-dir"]);
  if (!gitRootValue || !commonDirValue || !gitDirValue) {
    return {
      logicalProjectId: String(previous?.logicalProjectId || stableProjectId(projectRoot)),
      worktree: previous?.worktree && typeof previous.worktree === "object" ? previous.worktree : null,
      membershipIdentity: { kind: "path" },
    };
  }
  const gitRoot = stableRoot(gitRootValue);
  const commonDir = stableRoot(path.resolve(gitRoot, commonDirValue));
  const gitDir = stableRoot(path.resolve(gitRoot, gitDirValue));
  const gitEntry = path.join(gitRoot, ".git");
  const relativeRoot = path.relative(gitRoot, projectRoot).replaceAll(path.sep, "/") || ".";
  const branch = gitText(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = gitText(projectRoot, ["rev-parse", "--short=12", "HEAD"]);
  const mainWorktree = path.basename(commonDir) === ".git" && stableRoot(path.dirname(commonDir)) === gitRoot;
  const commonDirIdentity = contextHubProjectRootIdentity(commonDir);
  const gitDirIdentity = contextHubProjectRootIdentity(gitDir);
  const gitEntryIdentity = filesystemEntryIdentity(gitEntry);
  const logicalProjectId = createHash("sha256")
    .update(`git:${commonDir}\0${relativeRoot}`)
    .digest("hex")
    .slice(0, 24);
  return {
    logicalProjectId,
    membershipIdentity: {
      kind: "git",
      commonDir,
      commonDirIdentity,
      relativeRoot,
      gitDir,
      gitDirIdentity,
      gitEntryIdentity,
    },
    worktree: {
      branch: branch || (head ? `detached@${head}` : "detached"),
      head,
      gitRoot,
      relativeRoot,
      main: mainWorktree,
    },
  };
}

function cleanTitle(value, fallback) {
  return String(value || "").trim().slice(0, 160) || fallback;
}

function projectTitle(root) {
  const fallback = path.basename(root) || "Local project";
  if (!contextHubProjectControlFilesAreSafe(root)) return fallback;
  try {
    const config = readContextHubProjectControlJson(path.join(root, ".context-room", "config.json"));
    return cleanTitle(config.title, fallback);
  } catch {
    return fallback;
  }
}

function contextHubProjectControlFileError(filePath, reason) {
  const error = new Error(`Context Hub project control file is unsafe: ${filePath} (${reason})`);
  error.code = "context_hub_project_control_file_unsafe";
  error.statusCode = 409;
  return error;
}

function assertContextHubProjectControlFile(filePath, { required = false } = {}) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return false;
    if (error?.code === "ENOENT") throw new Error(`Context Hub project is not initialized: ${filePath}`);
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw contextHubProjectControlFileError(filePath, "expected a regular non-symbolic-link file");
  }
  if (stats.nlink !== 1) {
    throw contextHubProjectControlFileError(filePath, "hard links are not allowed; expected exactly one filesystem link");
  }
  if (stats.size > MAX_CONTEXT_HUB_PROJECT_CONTROL_FILE_BYTES) {
    throw contextHubProjectControlFileError(filePath, `file exceeds ${MAX_CONTEXT_HUB_PROJECT_CONTROL_FILE_BYTES} bytes`);
  }
  return stats;
}

function sameContextHubControlFileStats(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readContextHubProjectControlJson(filePath) {
  const pathStats = assertContextHubProjectControlFile(filePath, { required: true });
  const flags = fs.constants.O_RDONLY
    | Number(fs.constants.O_NOFOLLOW || 0)
    | Number(fs.constants.O_NONBLOCK || 0);
  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, flags);
    const before = fs.fstatSync(descriptor);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw contextHubProjectControlFileError(filePath, "entry changed before it could be read");
    }
    if (before.size > MAX_CONTEXT_HUB_PROJECT_CONTROL_FILE_BYTES) {
      throw contextHubProjectControlFileError(filePath, `file exceeds ${MAX_CONTEXT_HUB_PROJECT_CONTROL_FILE_BYTES} bytes`);
    }
    if (!sameContextHubControlFileStats(pathStats, before)) {
      throw contextHubProjectControlFileError(filePath, "entry identity changed before it could be read");
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    const grew = fs.readSync(descriptor, extra, 0, 1, offset) > 0;
    const after = fs.fstatSync(descriptor);
    const visible = fs.lstatSync(filePath);
    if (grew || offset !== before.size
      || !sameContextHubControlFileStats(before, after)
      || !sameContextHubControlFileStats(before, visible)) {
      throw contextHubProjectControlFileError(filePath, "entry changed while it was being read");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function assertContextHubProjectControlFiles(root, expectedRootIdentity = null) {
  const projectRoot = path.resolve(root);
  const rootIdentity = contextHubProjectRootIdentity(projectRoot);
  const expected = normalizedProjectRootIdentity(expectedRootIdentity);
  if (expected && (rootIdentity.dev !== expected.dev || rootIdentity.ino !== expected.ino)) {
    throw contextHubProjectControlFileError(projectRoot, "project root filesystem identity changed");
  }
  const contextRoomDirectory = path.join(projectRoot, ".context-room");
  let directoryStats;
  try {
    directoryStats = fs.lstatSync(contextRoomDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Context Hub project is not initialized: ${path.join(contextRoomDirectory, "config.json")}`);
    throw error;
  }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw contextHubProjectControlFileError(contextRoomDirectory, "expected a regular non-symbolic-link directory");
  }
  assertContextHubProjectControlFile(path.join(contextRoomDirectory, "config.json"), { required: true });
  assertContextHubProjectControlFile(path.join(contextRoomDirectory, "review-gate.json"));
  return true;
}

function contextHubProjectControlFilesAreSafe(root) {
  try {
    return assertContextHubProjectControlFiles(root);
  } catch {
    return false;
  }
}

const REPOSITORY_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

function repositoryUrl(value) {
  const repository = String(value || "").trim();
  if (!REPOSITORY_URL_PATTERN.test(repository)) return null;
  try {
    return new URL(repository);
  } catch {
    throw new Error("Shared repository must be a valid Git URL or local path");
  }
}

function cleanRepository(value) {
  const repository = String(value || "").trim();
  if (!repository || /[\u0000\r\n]/.test(repository)) throw new Error("Shared repository URL is required");
  const parsed = repositoryUrl(repository);
  if (parsed && (parsed.password || (parsed.username && parsed.protocol !== "ssh:") || parsed.search || parsed.hash)) {
    throw new Error("Shared repository URLs must not contain embedded credentials, query parameters, or fragments");
  }
  return repository;
}

function scpRepository(value) {
  const repository = String(value || "");
  if (repository.includes("://")) return null;
  if (/^[a-z]:[\\/]/i.test(repository)) return null;
  const match = /^(?:([^@/:\s]+)@)?([^@/:\s]+):(.+)$/.exec(repository);
  if (!match) return null;
  const [, username = "", hostname, repositoryPath] = match;
  return { username, hostname: hostname.toLowerCase(), repositoryPath };
}

function localFileRepositoryPath(parsed) {
  const hostname = String(parsed.hostname || "").toLowerCase();
  if (hostname) {
    const currentHostname = String(os.hostname() || "").toLowerCase();
    const shortHostname = currentHostname.split(".")[0];
    const localHostnames = new Set([
      currentHostname,
      shortHostname,
      shortHostname ? `${shortHostname}.local` : "",
      "127.0.0.1",
      "[::1]",
    ].filter(Boolean));
    if (process.platform !== "darwin" || !localHostnames.has(hostname)) {
      const error = new Error(`Shared file repository host is not proven local: ${parsed.hostname}`);
      error.code = "shared_repository_file_host_not_local";
      error.statusCode = 400;
      throw error;
    }
  }
  const localUrl = new URL(parsed.href);
  localUrl.hostname = "";
  return stableLocalRepositoryPath(fileURLToPath(localUrl));
}

function githubRepositoryPath(candidate) {
  const repositoryPath = String(candidate || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  const segments = repositoryPath.split("/");
  if (segments.length !== 2 || segments.some((segment) => !/^[a-z0-9._-]+$/i.test(segment))) return "";
  return segments.map((segment) => segment.toLowerCase()).join("/");
}

function canonicalRepositoryForStorage(value) {
  const repository = cleanRepository(value);
  const parsed = repositoryUrl(repository);
  if (parsed) {
    if (parsed.protocol === "file:") {
      return pathToFileURL(localFileRepositoryPath(parsed)).href;
    }
    const githubSshPath = parsed.protocol === "ssh:"
      && parsed.username === "git"
      && parsed.hostname === "github.com"
      && (!parsed.port || parsed.port === "22")
      && !parsed.search
      && !parsed.hash
      && githubRepositoryPath(parsed.pathname);
    if (githubSshPath) {
      const repositoryPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
      return `git@github.com:${repositoryPath}`;
    }
    return parsed.href;
  }
  if (scpRepository(repository)) return repository;
  return stableLocalRepositoryPath(repository);
}

function repositoryIdentity(value) {
  const repository = cleanRepository(value);
  const scp = scpRepository(repository);
  if (scp) {
    const githubPath = scp.username === "git" && scp.hostname === "github.com"
      ? githubRepositoryPath(scp.repositoryPath)
      : "";
    if (githubPath) return `github:${githubPath}`;
    return `scp:${scp.username ? `${scp.username}@` : ""}${scp.hostname}:${scp.repositoryPath}`;
  }
  const parsed = repositoryUrl(repository);
  if (parsed) {
    if (parsed.protocol === "file:") {
      return `local:${localFileRepositoryPath(parsed)}`;
    }
    const githubAlias = parsed.hostname === "github.com"
      && !parsed.search
      && !parsed.hash
      && (
        (parsed.protocol === "https:" && !parsed.username && !parsed.port)
        || (parsed.protocol === "ssh:" && parsed.username === "git" && (!parsed.port || parsed.port === "22"))
      );
    const githubPath = githubAlias ? githubRepositoryPath(parsed.pathname) : "";
    if (githubPath) return `github:${githubPath}`;
    return `url:${parsed.href}`;
  }
  return `local:${stableLocalRepositoryPath(repository)}`;
}

export function contextHubRepositoryIdentity(repository) {
  return repositoryIdentity(repository);
}

const HUB_SHARED_TRANSACTION_VERSION = 5;
const MAX_HUB_SHARED_TRANSACTION_PROJECTS = 1_024;
const MAX_HUB_SHARED_TRANSACTION_BYTES = 2_097_152;
const activeHubSharedTransactions = new Set();

function sharedHomePath() {
  return process.env.CONTEXT_ROOM_SHARED_HOME
    ? path.resolve(process.env.CONTEXT_ROOM_SHARED_HOME)
    : path.join(process.env.HOME || os.homedir(), ".context-room", "shared");
}

function sharedRegistryPath() {
  return path.join(sharedHomePath(), "registry.json");
}

function sharedRegistryLockPath() {
  return `${sharedRegistryPath()}.lock`;
}

function sharedTransactionDirectory() {
  return path.join(hubHome(), "shared-transactions");
}

function abandonedSharedTransactionDirectory() {
  return path.join(sharedTransactionDirectory(), "abandoned");
}

function invalidSharedTransactionDirectory() {
  return path.join(sharedTransactionDirectory(), "invalid");
}

function abandonedInvalidSharedTransactionDirectory() {
  return path.join(sharedTransactionDirectory(), "abandoned-invalid");
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function durableUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  fsyncDirectory(path.dirname(filePath));
  return true;
}

function processIsAlive(pid) {
  const candidate = Number(pid);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) return false;
  try {
    process.kill(candidate, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processGenerationIdentity(pid) {
  const candidate = Number(pid);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) return "";
  if (process.platform === "linux") {
    try {
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
      const processStat = fs.readFileSync(`/proc/${candidate}/stat`, "utf8").trim();
      const commandEnd = processStat.lastIndexOf(")");
      const startTimeTicks = commandEnd >= 2 ? processStat.slice(commandEnd + 1).trim().split(/\s+/)[19] : "";
      if (/^[0-9a-f-]{36}$/.test(bootId) && /^\d+$/.test(startTimeTicks || "")) return `linux:${bootId}:${startTimeTicks}`;
    } catch {}
    return "";
  }
  if (process.platform === "darwin") {
    try {
      const startedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(candidate)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
        maxBuffer: 4_096,
      }).trim().replace(/\s+/g, " ");
      return startedAt ? `darwin:${startedAt}` : "";
    } catch {}
  }
  return "";
}

function transactionOwnerIsAlive(transaction) {
  if (!processIsAlive(transaction.ownerPid)) return false;
  if (!transaction.ownerProcessIdentity) return true;
  const currentIdentity = processGenerationIdentity(transaction.ownerPid);
  return !currentIdentity || currentIdentity === transaction.ownerProcessIdentity;
}

function normalizedSharedReference(value) {
  if (!value?.repository || !value?.projectId) return null;
  const repository = canonicalRepositoryForStorage(value.repository);
  const projectId = String(value.projectId || "").trim();
  if (!projectId || /[\u0000\r\n]/.test(projectId)) throw new Error("Shared project ID is invalid");
  return { repository, repositoryIdentity: repositoryIdentity(repository), projectId };
}

function sameSharedReference(left, right) {
  if (!left || !right) return !left && !right;
  try {
    return repositoryIdentity(left.repository) === repositoryIdentity(right.repository)
      && String(left.projectId || "") === String(right.projectId || "");
  } catch {
    return false;
  }
}

function sharedSourceIdentity(root) {
  const resolved = stableRoot(root);
  const topLevel = gitText(resolved, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return null;
  const transports = gitText(topLevel, ["remote"]).split("\n").filter(Boolean)
    .flatMap((name) => gitText(topLevel, ["remote", "get-url", "--all", name]).split("\n"))
    .map((remote) => String(remote || "").trim())
    .filter(Boolean);
  if (!transports.length) return null;
  const stableTopLevel = stableRoot(topLevel);
  return {
    transports: [...new Set(transports)],
    remoteIdentities: [...new Set(transports.map(repositoryIdentity))],
    sourceSubpath: path.relative(stableTopLevel, resolved).replaceAll(path.sep, "/") || ".",
  };
}

function bindingSourceRemoteIdentities(binding) {
  if (Number(binding?.sourceIdentityVersion) !== 2
    || !Array.isArray(binding?.sourceRemotes)
    || !Array.isArray(binding?.sourceRemoteIdentities)) return [];
  const transports = binding.sourceRemotes.map((remote) => String(remote || "").trim()).filter(Boolean);
  let identities;
  try {
    identities = [...new Set(transports.map(repositoryIdentity))];
  } catch {
    return [];
  }
  const recorded = [...new Set(binding.sourceRemoteIdentities.map((identity) => String(identity || "").trim()).filter(Boolean))];
  if (identities.length !== recorded.length || identities.some((identity) => !recorded.includes(identity))) return [];
  return identities;
}

function sharedBindingMatchesRoot(binding, root) {
  const resolvedRoot = stableRoot(root);
  const registeredRoots = [...(Array.isArray(binding?.projectRoots) ? binding.projectRoots : []), binding?.sourceRoot]
    .filter(Boolean)
    .flatMap((candidate) => {
      try { return [stableRoot(candidate)]; } catch { return []; }
    });
  if (registeredRoots.some((candidate) => resolvedRoot === candidate || resolvedRoot.startsWith(candidate + path.sep))) return true;
  const source = sharedSourceIdentity(resolvedRoot);
  if (!source) return false;
  const bindingRemotes = bindingSourceRemoteIdentities(binding);
  if (!source.remoteIdentities.some((remote) => bindingRemotes.includes(remote))) return false;
  const bindingPath = String(binding?.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const sourcePath = String(source.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return bindingPath === "." || sourcePath === bindingPath || sourcePath.startsWith(bindingPath + "/");
}

function readSharedBindingStateLocked(transaction) {
  const raw = readJson(sharedRegistryPath(), { version: 1, bindings: [] });
  if (!raw || Number(raw.version || 1) !== 1 || !Array.isArray(raw.bindings)) {
    const error = new Error("Shared Context registry is invalid while recovering Context Hub");
    error.code = "context_hub_shared_registry_invalid";
    throw error;
  }
  const roots = transaction.projectGroup?.length
    ? transaction.projectGroup.map((entry) => entry.root)
    : [transaction.projectRoot];
  const states = roots.map((root) => {
    const rootBindings = raw.bindings.filter((binding) => sharedBindingMatchesRoot(binding, root));
    const matching = rootBindings.filter((binding) => {
      try {
        return repositoryIdentity(binding.repository) === transaction.shared.repositoryIdentity
          && String(binding.projectId || "") === transaction.shared.projectId;
      } catch {
        return false;
      }
    });
    return { root, connected: matching.length > 0, conflicting: rootBindings.length > matching.length };
  });
  const connectedRoots = states.filter((state) => state.connected).length;
  return {
    connected: connectedRoots === states.length,
    partiallyConnected: connectedRoots > 0 && connectedRoots < states.length,
    conflicting: states.some((state) => state.conflicting),
  };
}

function withSharedBindingState(transaction, operation) {
  // Shared disconnect has its own durable journal. Resolve that store first so
  // registry.json is the committed authority observed by the Hub journal.
  recoverSharedContextTransactions();
  const lockPath = sharedRegistryLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  return withFilesystemLock(lockPath, () => operation(readSharedBindingStateLocked(transaction)), {
    timeoutMs: REGISTRY_LOCK_TIMEOUT_MS,
    staleMs: REGISTRY_LOCK_STALE_MS,
    busyMessage: "Shared Context registry is busy while Context Hub is recovering",
    busyCode: "context_hub_shared_registry_busy",
  });
}

function normalizedHubSharedTransaction(raw, filePath) {
  const version = Number(raw?.version);
  if (!raw || ![1, 2, 3, 4, HUB_SHARED_TRANSACTION_VERSION].includes(version) || !["connect", "disconnect"].includes(raw.operation)) {
    throw Object.assign(new Error(`Invalid Context Hub Shared transaction: ${filePath}`), { code: "context_hub_shared_transaction_invalid" });
  }
  const projectRoot = path.resolve(String(raw.projectRoot || ""));
  const rootIdentity = normalizedProjectRootIdentity(raw.rootIdentity);
  const projectId = String(raw.projectId || "");
  const logicalProjectId = String(raw.logicalProjectId || "");
  const ownerPid = Number(raw.ownerPid);
  const ownerThreadId = Number(raw.ownerThreadId || 0);
  const ownerProcessIdentity = String(raw.ownerProcessIdentity || "");
  const transactionId = String(raw.transactionId || "");
  const shared = normalizedSharedReference(raw.shared);
  const beforeShared = normalizedSharedReference(raw.beforeShared);
  const completionRequirement = version < 3 ? "legacy" : String(raw.completionRequirement || "");
  const rawRecoveryRequired = raw.recoveryRequired;
  const recoveryRequired = rawRecoveryRequired == null ? null : {
    code: String(rawRecoveryRequired?.code || ""),
    message: String(rawRecoveryRequired?.message || "").slice(0, 500),
    detectedAt: String(rawRecoveryRequired?.detectedAt || ""),
  };
  const rawResolution = raw.resolution;
  const resolution = rawResolution == null ? null : {
    action: String(rawResolution?.action || ""),
    requestedAt: String(rawResolution?.requestedAt || ""),
  };
  const rawProjectGroup = version === 1 ? [{
    id: projectId,
    root: projectRoot,
    rootIdentity,
  }] : raw.projectGroup;
  const projectGroup = Array.isArray(rawProjectGroup) ? rawProjectGroup.flatMap((entry) => {
    const root = path.resolve(String(entry?.root || ""));
    const id = String(entry?.id || "");
    const entryRootIdentity = normalizedProjectRootIdentity(entry?.rootIdentity);
    const worktreeIdentity = version < 4 ? null : normalizedWorktreeMembershipIdentity(entry?.worktreeIdentity);
    return id === stableStoredProjectId(root)
      && entryRootIdentity
      && (version < 4 || worktreeIdentity)
      && (version < 5 || worktreeMembershipIdentityIsAnchored(worktreeIdentity))
      ? [{ id, root, rootIdentity: entryRootIdentity, worktreeIdentity }]
      : [];
  }) : [];
  const projectIds = new Set(projectGroup.map((entry) => entry.id));
  const selectedGroupEntry = projectGroup.find((entry) => entry.id === projectId);
  if (
    !transactionId
    || path.basename(filePath) !== `${transactionId}.json`
    || projectId !== stableStoredProjectId(projectRoot)
    || !rootIdentity
    || !/^[a-f0-9]{24}$/.test(logicalProjectId)
    || !Number.isSafeInteger(ownerPid)
    || ownerPid <= 0
    || !Number.isSafeInteger(ownerThreadId)
    || ownerThreadId < 0
    || ownerProcessIdentity.length > 512
    || projectGroup.length < 1
    || projectGroup.length > MAX_HUB_SHARED_TRANSACTION_PROJECTS
    || projectGroup.length !== rawProjectGroup?.length
    || projectIds.size !== projectGroup.length
    || !selectedGroupEntry
    || selectedGroupEntry.root !== projectRoot
    || selectedGroupEntry.rootIdentity.dev !== rootIdentity.dev
    || selectedGroupEntry.rootIdentity.ino !== rootIdentity.ino
    || !["binding", "synced", "legacy"].includes(completionRequirement)
    || (recoveryRequired && (
      recoveryRequired.code !== "context_hub_shared_transaction_conflict"
      || !recoveryRequired.detectedAt
      || !Number.isFinite(Date.parse(recoveryRequired.detectedAt))
    ))
    || (resolution && (
      resolution.action !== "abandon"
      || !resolution.requestedAt
      || !Number.isFinite(Date.parse(resolution.requestedAt))
      || !recoveryRequired
    ))
    || !shared
    || (raw.operation === "disconnect" && !beforeShared)
    || (raw.operation === "connect" && beforeShared && !sameSharedReference(beforeShared, shared))
  ) {
    throw Object.assign(new Error(`Invalid Context Hub Shared transaction identity: ${filePath}`), { code: "context_hub_shared_transaction_invalid" });
  }
  return {
    version,
    transactionId,
    operation: raw.operation,
    ownerPid,
    ownerThreadId,
    ownerProcessIdentity,
    createdAt: String(raw.createdAt || ""),
    projectRoot,
    rootIdentity,
    projectId,
    logicalProjectId,
    projectGroup: projectGroup.sort((left, right) => left.id.localeCompare(right.id)),
    beforeShared,
    shared,
    completionRequirement,
    recoveryRequired,
    resolution,
    filePath,
  };
}

function hubSharedTransactionPayload(transaction, overrides = {}) {
  const recoveryRequired = Object.hasOwn(overrides, "recoveryRequired")
    ? overrides.recoveryRequired
    : transaction.recoveryRequired;
  const resolution = Object.hasOwn(overrides, "resolution") ? overrides.resolution : transaction.resolution;
  return {
    version: transaction.version || HUB_SHARED_TRANSACTION_VERSION,
    transactionId: transaction.transactionId,
    operation: transaction.operation,
    ownerPid: transaction.ownerPid,
    ownerThreadId: transaction.ownerThreadId,
    ownerProcessIdentity: transaction.ownerProcessIdentity,
    createdAt: transaction.createdAt,
    projectRoot: transaction.projectRoot,
    rootIdentity: transaction.rootIdentity,
    projectId: transaction.projectId,
    logicalProjectId: transaction.logicalProjectId,
    projectGroup: transaction.projectGroup.map((entry) => ({
      id: entry.id,
      root: entry.root,
      rootIdentity: entry.rootIdentity,
      worktreeIdentity: entry.worktreeIdentity,
    })),
    beforeShared: transaction.beforeShared ? {
      repository: transaction.beforeShared.repository,
      projectId: transaction.beforeShared.projectId,
    } : null,
    shared: {
      repository: transaction.shared.repository,
      projectId: transaction.shared.projectId,
    },
    completionRequirement: transaction.completionRequirement || "binding",
    ...(recoveryRequired ? { recoveryRequired } : {}),
    ...(resolution ? { resolution } : {}),
  };
}

function ensurePrivateHubSharedTransactionDirectory(directory, invalidCode = "context_hub_shared_transaction_store_invalid") {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw Object.assign(new Error(`Context Hub Shared transaction store is not a private directory: ${directory}`), { code: invalidCode });
  }
  fs.chmodSync(directory, 0o700);
  return directory;
}

function quarantineInvalidHubSharedTransactionLocked(filePath, error) {
  const directory = ensurePrivateHubSharedTransactionDirectory(invalidSharedTransactionDirectory());
  const originalName = path.basename(filePath);
  const quarantineId = randomUUID();
  const stagingDirectory = path.join(directory, `.${quarantineId}.tmp`);
  const issueDirectory = path.join(directory, quarantineId);
  fs.mkdirSync(stagingDirectory, { mode: 0o700 });
  const sourceStats = fs.lstatSync(filePath, { bigint: true });
  const entryIdentity = {
    dev: sourceStats.dev.toString(),
    ino: sourceStats.ino.toString(),
    mode: sourceStats.mode.toString(),
    nlink: sourceStats.nlink.toString(),
    size: sourceStats.size.toString(),
  };
  const quarantinedAt = new Date().toISOString();
  const revision = createHash("sha256").update(JSON.stringify({
    quarantineId,
    originalName,
    entryIdentity,
    quarantinedAt,
  })).digest("hex");
  writeJson(path.join(stagingDirectory, "meta.json"), {
    version: 1,
    quarantineId,
    originalName,
    quarantinedAt,
    code: String(error?.code || "context_hub_shared_transaction_invalid").slice(0, 120),
    message: String(error?.message || "Invalid Context Hub Shared transaction").slice(0, 500),
    entryIdentity,
    revision,
  });
  // Persist the staging directory name before removing the active journal
  // name. At least one durable name must exist across every crash boundary.
  fsyncDirectory(directory);
  try {
    fs.renameSync(filePath, path.join(stagingDirectory, "journal"));
  } catch (renameError) {
    durableUnlink(path.join(stagingDirectory, "meta.json"));
    fs.rmdirSync(stagingDirectory);
    throw renameError;
  }
  fsyncDirectory(stagingDirectory);
  fsyncDirectory(sharedTransactionDirectory());
  fs.renameSync(stagingDirectory, issueDirectory);
  fsyncDirectory(directory);
  fsyncDirectory(sharedTransactionDirectory());
  invalidateContextHubSnapshotLocked();
  return issueDirectory;
}

function recoverInvalidHubSharedQuarantineStagingLocked() {
  const directory = invalidSharedTransactionDirectory();
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory).filter((entry) => /^\.[0-9a-f-]{36}\.tmp$/.test(entry)).sort()) {
    const stagingDirectory = path.join(directory, name);
    const quarantineId = name.slice(1, -4);
    const issueDirectory = path.join(directory, quarantineId);
    const stats = fs.lstatSync(stagingDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
    if (fs.existsSync(path.join(stagingDirectory, "journal"))) {
      if (!fs.existsSync(issueDirectory)) fs.renameSync(stagingDirectory, issueDirectory);
      continue;
    }
    let originalJournalStillExact = false;
    try {
      const metadata = readJson(path.join(stagingDirectory, "meta.json"));
      const originalName = String(metadata?.originalName || "");
      const originalPath = path.join(sharedTransactionDirectory(), originalName);
      const expectedIdentity = metadata?.entryIdentity || {};
      const originalStats = fs.lstatSync(originalPath, { bigint: true });
      originalJournalStillExact = originalName.endsWith(".json")
        && path.basename(originalPath) === originalName
        && originalStats.isFile()
        && !originalStats.isSymbolicLink()
        && originalStats.dev.toString() === String(expectedIdentity.dev || "")
        && originalStats.ino.toString() === String(expectedIdentity.ino || "")
        && originalStats.mode.toString() === String(expectedIdentity.mode || "")
        && originalStats.nlink.toString() === String(expectedIdentity.nlink || "")
        && originalStats.size.toString() === String(expectedIdentity.size || "");
    } catch {}
    if (originalJournalStillExact) {
      try { durableUnlink(path.join(stagingDirectory, "meta.json")); } catch {}
      try { fs.rmdirSync(stagingDirectory); } catch {}
    } else if (!fs.existsSync(issueDirectory)) {
      // The active journal may already have been durably renamed before a
      // crash lost or corrupted the staged journal entry. Preserve the whole
      // staging directory as an explicit generic recovery issue; never infer
      // that missing staged data means there was no cross-store transaction.
      fs.renameSync(stagingDirectory, issueDirectory);
    }
  }
  fsyncDirectory(directory);
}

function genericInvalidHubSharedRecoveryIssue(issueDirectory, quarantineId, error) {
  const stats = fs.lstatSync(issueDirectory, { bigint: true });
  const revision = createHash("sha256")
    .update(`invalid:${quarantineId}:${stats.dev}:${stats.ino}:${stats.mtimeNs || stats.mtimeMs}`)
    .digest("hex");
  return {
    status: "recovery-required",
    scope: "global",
    kind: "invalid-journal",
    quarantineId,
    originalName: "unknown.json",
    quarantinedAt: "",
    code: "context_hub_shared_transaction_quarantine_invalid",
    message: String(error?.message || "Quarantined Shared recovery metadata is unreadable").slice(0, 500),
    revision,
    issueDirectory,
  };
}

function normalizedInvalidHubSharedRecoveryIssue(raw, issueDirectory) {
  const quarantineId = String(raw?.quarantineId || "");
  const originalName = String(raw?.originalName || "");
  const quarantinedAt = String(raw?.quarantinedAt || "");
  const revision = String(raw?.revision || "");
  const entryIdentity = {
    dev: String(raw?.entryIdentity?.dev || ""),
    ino: String(raw?.entryIdentity?.ino || ""),
    mode: String(raw?.entryIdentity?.mode || ""),
    nlink: String(raw?.entryIdentity?.nlink || ""),
    size: String(raw?.entryIdentity?.size || ""),
  };
  const expectedRevision = createHash("sha256").update(JSON.stringify({
    quarantineId,
    originalName,
    entryIdentity,
    quarantinedAt,
  })).digest("hex");
  if (
    path.basename(issueDirectory) !== quarantineId
    || !/^[0-9a-f-]{36}$/.test(quarantineId)
    || !originalName.endsWith(".json")
    || !Number.isFinite(Date.parse(quarantinedAt))
    || !Object.values(entryIdentity).every((value) => /^\d+$/.test(value))
    || revision !== expectedRevision
  ) {
    throw Object.assign(new Error("Invalid quarantined Context Hub Shared transaction metadata"), { code: "context_hub_shared_transaction_quarantine_invalid" });
  }
  const quarantinedPath = path.join(issueDirectory, "journal");
  const stats = fs.lstatSync(quarantinedPath, { bigint: true });
  if (
    stats.dev.toString() !== entryIdentity.dev
    || stats.ino.toString() !== entryIdentity.ino
    || stats.mode.toString() !== entryIdentity.mode
    || stats.nlink.toString() !== entryIdentity.nlink
    || stats.size.toString() !== entryIdentity.size
  ) {
    throw Object.assign(new Error("Quarantined Context Hub Shared transaction identity changed"), { code: "context_hub_shared_transaction_quarantine_invalid" });
  }
  return {
    status: "recovery-required",
    scope: "global",
    kind: "invalid-journal",
    quarantineId,
    originalName,
    quarantinedAt,
    code: String(raw?.code || "context_hub_shared_transaction_invalid").slice(0, 120),
    message: String(raw?.message || "An unreadable Shared recovery journal was quarantined").slice(0, 500),
    revision,
    entryIdentity,
    issueDirectory,
    metadataPath: path.join(issueDirectory, "meta.json"),
    quarantinedPath,
  };
}

function readInvalidHubSharedRecoveryIssuesLocked() {
  const directory = invalidSharedTransactionDirectory();
  if (!fs.existsSync(directory)) return [];
  recoverInvalidHubSharedQuarantineStagingLocked();
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw Object.assign(new Error("Context Hub invalid Shared transaction store is not a private directory"), { code: "context_hub_shared_transaction_store_invalid" });
  }
  return fs.readdirSync(directory)
    .filter((name) => /^[0-9a-f-]{36}$/.test(name))
    .sort()
    .map((name) => {
      const issueDirectory = path.join(directory, name);
      try {
        const issueStats = fs.lstatSync(issueDirectory);
        const metadataPath = path.join(issueDirectory, "meta.json");
        const metadataStats = fs.lstatSync(metadataPath);
        if (!issueStats.isDirectory() || issueStats.isSymbolicLink()
          || !metadataStats.isFile() || metadataStats.isSymbolicLink()
          || metadataStats.nlink !== 1 || metadataStats.size > 65_536) {
          throw new Error("Context Hub Shared recovery quarantine metadata is unsafe");
        }
        return normalizedInvalidHubSharedRecoveryIssue(readJson(metadataPath), issueDirectory);
      } catch (error) {
        return genericInvalidHubSharedRecoveryIssue(issueDirectory, name, error);
      }
    });
}

function assertNoUnknownHubSharedRecoveryLocked() {
  const [issue] = [
    ...readInvalidHubSharedRecoveryIssuesLocked(),
    ...peekSharedDisconnectRecoveryIssues(),
  ];
  if (!issue) return;
  const error = new Error("An unreadable Shared recovery journal requires explicit owner resolution");
  error.code = "context_hub_shared_recovery_required";
  error.statusCode = 409;
  error.details = { quarantineId: issue.quarantineId, revision: issue.revision, scope: "global" };
  throw error;
}

function readHubSharedTransactionsLocked() {
  const directory = sharedTransactionDirectory();
  if (!fs.existsSync(directory)) return [];
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw Object.assign(new Error("Context Hub Shared transaction store is not a private directory"), { code: "context_hub_shared_transaction_store_invalid" });
  }
  const transactions = [];
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const filePath = path.join(directory, name);
      const fileStats = fs.lstatSync(filePath);
      if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.nlink !== 1 || fileStats.size > MAX_HUB_SHARED_TRANSACTION_BYTES) {
        throw Object.assign(new Error(`Context Hub Shared transaction is not a private file: ${filePath}`), { code: "context_hub_shared_transaction_invalid" });
      }
      transactions.push(normalizedHubSharedTransaction(readJson(filePath), filePath));
    } catch (error) {
      quarantineInvalidHubSharedTransactionLocked(path.join(directory, name), error);
    }
  }
  return transactions;
}

function assertNoPendingHubSharedTransactionLocked(predicate, message = "This project has a Shared transaction in progress") {
  const pending = readHubSharedTransactionsLocked().find(predicate);
  if (!pending) return;
  const error = new Error(message);
  error.code = "context_hub_shared_transaction_busy";
  error.statusCode = 409;
  error.details = { transactionId: pending.transactionId, operation: pending.operation, projectId: pending.projectId };
  throw error;
}

function sharedStateForProject(project) {
  return normalizedSharedReference(project?.shared);
}

function assertTransactionHubCas(registry, transaction) {
  const group = registry.projects.filter((entry) => (entry.logicalProjectId || entry.id) === transaction.logicalProjectId);
  const currentById = new Map(group.map((entry) => [entry.id, entry]));
  const identitiesMatch = group.length === transaction.projectGroup.length
    && transaction.projectGroup.every((expected) => {
      const current = currentById.get(expected.id);
      const currentRootIdentity = normalizedProjectRootIdentity(current?.rootIdentity);
      const currentWorktreeIdentity = current ? gitWorktreeIdentity(current.root) : null;
      const membershipMatches = expected.worktreeIdentity
        ? sameWorktreeMembershipIdentity(currentWorktreeIdentity?.membershipIdentity, expected.worktreeIdentity)
        : currentWorktreeIdentity?.membershipIdentity?.kind === "path";
      return Boolean(current)
        && path.resolve(current.root) === expected.root
        && currentRootIdentity?.dev === expected.rootIdentity.dev
        && currentRootIdentity?.ino === expected.rootIdentity.ino
        && contextHubProjectRootMatchesIdentity(current.root, expected.rootIdentity)
        && currentWorktreeIdentity?.logicalProjectId === transaction.logicalProjectId
        && membershipMatches
        && (current.logicalProjectId || current.id) === transaction.logicalProjectId;
    });
  if (!identitiesMatch) {
    throw Object.assign(new Error("The Context Hub project group identity changed during its Shared transaction"), { code: "context_hub_shared_transaction_conflict" });
  }
  const states = group.map(sharedStateForProject);
  const allBefore = states.every((state) => sameSharedReference(state, transaction.beforeShared));
  const target = transaction.operation === "connect" ? transaction.shared : null;
  const allTarget = states.every((state) => sameSharedReference(state, target));
  if (!allBefore && !allTarget) {
    throw Object.assign(new Error("The Context Hub Shared project changed concurrently"), { code: "context_hub_shared_transaction_conflict" });
  }
  return { group, allTarget, target };
}

function applyRecoveredHubSharedStateLocked(transaction, target) {
  const registry = readContextHubRegistryRaw();
  const { allTarget } = assertTransactionHubCas(registry, transaction);
  if (!allTarget) {
    registry.projects = registry.projects.map((entry) => (
      (entry.logicalProjectId || entry.id) === transaction.logicalProjectId
        ? { ...entry, shared: target ? { repository: target.repository, projectId: target.projectId } : null }
        : entry
    ));
    if (target) {
      const existing = registry.sharedRepositories.find((entry) => repositoryIdentity(entry.repository) === target.repositoryIdentity);
      if (!existing) registry.sharedRepositories.push({ repository: target.repository, addedAt: new Date().toISOString() });
    }
    writeJson(registryPath(), registry);
    invalidateContextHubSnapshotLocked();
  }
  durableUnlink(transaction.filePath);
  return { recovered: true };
}

function sharedConnectionHasSyncedCommitWitness(transaction) {
  try {
    const status = sharedContextStatus(transaction.projectRoot);
    if (!status?.connected || !status.cacheRoot) return false;
    if (!sameSharedReference(status.connection, transaction.shared)) return false;
    let witnessedRevision = "";
    let witnessedProjectsPath = "";
    for (const member of transaction.projectGroup) {
      const receipt = readSharedConnectionReceipt(member.root, {
        repository: transaction.shared.repository,
        projectId: transaction.shared.projectId,
        receiptId: transaction.transactionId,
      });
      const memberStatus = sharedContextStatus(member.root);
      if (!receipt || !memberStatus?.connected || !sameSharedReference(memberStatus.connection, transaction.shared)) return false;
      if (witnessedRevision && receipt.revision !== witnessedRevision) return false;
      if (witnessedProjectsPath && receipt.projectsPath !== witnessedProjectsPath) return false;
      witnessedRevision = receipt.revision;
      witnessedProjectsPath = receipt.projectsPath;
      const config = readContextHubProjectControlJson(path.join(member.root, ".context-room", "config.json"));
      if (config.sharedContext?.enabled !== true || !sameSharedReference(config.sharedContext, transaction.shared)) return false;
    }
    const expectedSnapshot = path.join(status.cacheRoot, "snapshots", witnessedRevision);
    const projectsPath = witnessedProjectsPath;
    if (!projectsPath || path.isAbsolute(projectsPath) || projectsPath.split(/[\\/]+/).includes("..")) return false;
    const sharedProjectRoot = fs.realpathSync(path.resolve(expectedSnapshot, ...projectsPath.split("/"), transaction.shared.projectId));
    const physicalSnapshot = fs.realpathSync(expectedSnapshot);
    return sharedProjectRoot.startsWith(physicalSnapshot + path.sep)
      && fs.statSync(sharedProjectRoot).isDirectory();
  } catch {
    return false;
  }
}

function resolveHubSharedTransactionLocked(transaction) {
  assertTransactionHubCas(readContextHubRegistryRaw(), transaction);
  return withSharedBindingState(transaction, (sharedState) => {
    if (sharedState.conflicting || sharedState.partiallyConnected) {
      throw Object.assign(new Error("A different Shared binding appeared while Context Hub was recovering"), { code: "context_hub_shared_transaction_conflict" });
    }
    if (transaction.operation === "connect"
      && transaction.completionRequirement === "legacy"
      && sharedState.connected
      && !sameSharedReference(transaction.beforeShared, transaction.shared)) {
      throw Object.assign(new Error("A legacy Shared connection journal has no exact synchronization witness"), { code: "context_hub_shared_transaction_conflict" });
    }
    if (transaction.operation === "connect"
      && transaction.completionRequirement === "synced"
      && sharedState.connected
      && !sharedConnectionHasSyncedCommitWitness(transaction)) {
      throw Object.assign(new Error("The Shared connection exists but did not finish its required synchronization"), { code: "context_hub_shared_transaction_conflict" });
    }
    const target = sharedState.connected
      ? (transaction.operation === "connect" ? transaction.shared : transaction.beforeShared)
      : null;
    return {
      ...applyRecoveredHubSharedStateLocked(transaction, target),
      committed: transaction.operation === "connect" ? sharedState.connected : !sharedState.connected,
    };
  });
}

function markHubSharedTransactionConflictLocked(transaction, error) {
  if (transaction.recoveryRequired) return transaction;
  const recoveryRequired = {
    code: "context_hub_shared_transaction_conflict",
    message: String(error?.message || "Context Hub Shared transaction requires recovery").slice(0, 500),
    detectedAt: new Date().toISOString(),
  };
  writeJson(transaction.filePath, hubSharedTransactionPayload(transaction, { recoveryRequired }));
  invalidateContextHubSnapshotLocked();
  return normalizedHubSharedTransaction(readJson(transaction.filePath), transaction.filePath);
}

function assertTransactionAbandonmentCasLocked(registry, transaction) {
  const expectedById = new Map(transaction.projectGroup.map((entry) => [entry.id, entry]));
  const currentGroup = registry.projects.filter((entry) => (
    (entry.logicalProjectId || entry.id) === transaction.logicalProjectId
    || expectedById.has(entry.id)
  ));
  const exactRegistryIdentity = currentGroup.length === transaction.projectGroup.length
    && transaction.projectGroup.every((expected) => {
      const current = currentGroup.find((entry) => entry.id === expected.id);
      const currentRootIdentity = normalizedProjectRootIdentity(current?.rootIdentity);
      return Boolean(current)
        && path.resolve(current.root) === expected.root
        && currentRootIdentity?.dev === expected.rootIdentity.dev
        && currentRootIdentity?.ino === expected.rootIdentity.ino
        && (current.logicalProjectId || current.id) === transaction.logicalProjectId;
    });
  if (!exactRegistryIdentity) {
    const error = new Error("The Context Hub project registry changed after Shared recovery became required");
    error.code = "context_hub_shared_transaction_conflict";
    error.statusCode = 409;
    throw error;
  }
}

function archiveAbandonedHubSharedTransactionLocked(transaction) {
  assertTransactionAbandonmentCasLocked(readContextHubRegistryRaw(), transaction);
  const directory = abandonedSharedTransactionDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStats = fs.lstatSync(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw Object.assign(new Error("Context Hub abandoned Shared transaction store is not a private directory"), { code: "context_hub_shared_transaction_store_invalid" });
  }
  fs.chmodSync(directory, 0o700);
  const archivedPath = path.join(directory, `${transaction.transactionId}.json`);
  if (fs.existsSync(archivedPath)) {
    throw Object.assign(new Error("This Context Hub Shared transaction was already archived"), { code: "context_hub_shared_transaction_conflict" });
  }
  // Invalidate before the durable rename so a crash can leave, at worst, a
  // pending conflict on a stale snapshot rather than hiding an active one.
  invalidateContextHubSnapshotLocked();
  fs.renameSync(transaction.filePath, archivedPath);
  let durabilityWarning = "";
  try {
    fsyncDirectory(directory);
    fsyncDirectory(sharedTransactionDirectory());
  } catch (error) {
    durabilityWarning = String(error?.message || error || "The recovery archive directory could not be synchronized").slice(0, 500);
  }
  return {
    recovered: true,
    abandoned: true,
    committed: false,
    transactionId: transaction.transactionId,
    projectId: transaction.projectId,
    logicalProjectId: transaction.logicalProjectId,
    projectIds: transaction.projectGroup.map((entry) => entry.id),
    archivedPath,
    ...(durabilityWarning ? { durabilityWarning } : {}),
  };
}

function recoverContextHubSharedTransactionsLocked({ forceTransactionIds = new Set(), tolerateConflicts = false } = {}) {
  const recovered = [];
  recoverInvalidHubSharedQuarantineStagingLocked();
  const transactions = readHubSharedTransactionsLocked();
  recoverInvalidHubSharedQuarantineStagingLocked();
  // An unreadable journal has unknown scope and ordering. Keep every other
  // parseable transaction untouched until the owner explicitly acknowledges
  // the global issue; otherwise recovery could commit a transaction that the
  // unreadable journal was meant to precede or supersede.
  if (readInvalidHubSharedRecoveryIssuesLocked().length || peekSharedDisconnectRecoveryIssues().length) return recovered;
  for (const transaction of transactions) {
    const forced = forceTransactionIds.has(transaction.transactionId);
    if (!forced && activeHubSharedTransactions.has(transaction.transactionId)) continue;
    const currentOwnerIsolate = transaction.ownerPid === process.pid && transaction.ownerThreadId === threadId;
    if (!forced && !currentOwnerIsolate && transactionOwnerIsAlive(transaction)) continue;
    if (transaction.resolution?.action === "abandon") {
      recovered.push(archiveAbandonedHubSharedTransactionLocked(transaction));
      continue;
    }
    try {
      recovered.push({ transactionId: transaction.transactionId, ...resolveHubSharedTransactionLocked(transaction) });
    } catch (error) {
      if (!tolerateConflicts || error?.code !== "context_hub_shared_transaction_conflict") throw error;
      markHubSharedTransactionConflictLocked(transaction, error);
      recovered.push({ transactionId: transaction.transactionId, recovered: false, conflict: true });
    }
  }
  return recovered;
}

export function recoverContextHubSharedTransactions() {
  return withRegistryLock(() => recoverContextHubSharedTransactionsLocked(), { recoverSharedTransactions: false });
}

export function abandonContextHubSharedTransaction({
  transactionId = "",
  expectedProjectId = "",
  expectedLogicalProjectId = "",
} = {}) {
  const exactTransactionId = String(transactionId || "").trim();
  const exactProjectId = String(expectedProjectId || "").trim();
  const exactLogicalProjectId = String(expectedLogicalProjectId || "").trim();
  if (!exactTransactionId || !exactProjectId || !exactLogicalProjectId) {
    const error = new Error("Exact transaction, project, and logical project IDs are required to abandon Shared recovery");
    error.code = "context_hub_shared_transaction_identity_required";
    error.statusCode = 400;
    throw error;
  }
  return withRegistryLock(() => {
    const transaction = readHubSharedTransactionsLocked().find((entry) => entry.transactionId === exactTransactionId);
    if (!transaction) {
      const error = new Error("The Context Hub Shared recovery transaction no longer exists");
      error.code = "context_hub_shared_transaction_not_found";
      error.statusCode = 404;
      throw error;
    }
    if (transaction.projectId !== exactProjectId || transaction.logicalProjectId !== exactLogicalProjectId) {
      const error = new Error("The Context Hub Shared recovery identity changed");
      error.code = "context_hub_shared_transaction_conflict";
      error.statusCode = 409;
      throw error;
    }
    const currentOwnerIsolate = transaction.ownerPid === process.pid && transaction.ownerThreadId === threadId;
    if (activeHubSharedTransactions.has(transaction.transactionId)
      || (!currentOwnerIsolate && transactionOwnerIsAlive(transaction))) {
      const error = new Error("The Context Hub Shared transaction is still active");
      error.code = "context_hub_shared_transaction_busy";
      error.statusCode = 409;
      throw error;
    }
    if (!transaction.recoveryRequired) {
      const error = new Error("This Context Hub Shared transaction does not require abandonment");
      error.code = "context_hub_shared_transaction_not_recovery_required";
      error.statusCode = 409;
      throw error;
    }
    let registry = readContextHubRegistryRaw();
    assertTransactionAbandonmentCasLocked(registry, transaction);
    let orphanCleanup = null;
    const originalRootsUnavailable = transaction.projectGroup.every((entry) => (
      !contextHubProjectRootMatchesIdentity(entry.root, entry.rootIdentity)
    ));
    const canResolveToDisconnected = transaction.operation === "disconnect" || !transaction.beforeShared;
    if (originalRootsUnavailable && canResolveToDisconnected) {
      orphanCleanup = removeOrphanedSharedContextBindings({
        repository: transaction.shared.repository,
        projectId: transaction.shared.projectId,
        projectRoots: transaction.projectGroup.map((entry) => ({
          root: entry.root,
          rootIdentity: entry.rootIdentity,
          worktreeIdentity: entry.worktreeIdentity,
        })),
      });
      registry = readContextHubRegistryRaw();
      assertTransactionAbandonmentCasLocked(registry, transaction);
      const hadCanonicalShared = registry.projects.some((entry) => (
        (entry.logicalProjectId || entry.id) === transaction.logicalProjectId && entry.shared
      ));
      if (hadCanonicalShared) {
        registry.projects = registry.projects.map((entry) => (
          (entry.logicalProjectId || entry.id) === transaction.logicalProjectId
            ? { ...entry, shared: null }
            : entry
        ));
        writeJson(registryPath(), registry);
        invalidateContextHubSnapshotLocked();
      }
    }
    const resolution = { action: "abandon", requestedAt: new Date().toISOString() };
    writeJson(transaction.filePath, hubSharedTransactionPayload(transaction, { resolution }));
    const prepared = normalizedHubSharedTransaction(readJson(transaction.filePath), transaction.filePath);
    return {
      ...archiveAbandonedHubSharedTransactionLocked(prepared),
      orphanBindingRemoved: Boolean(orphanCleanup?.removed),
      canonicalSharedCleared: Boolean(orphanCleanup),
    };
  });
}

export function listContextHubSharedRecoveryIssues() {
  return withRegistryLock(() => [
    ...readInvalidHubSharedRecoveryIssuesLocked(),
    ...listSharedDisconnectRecoveryIssues(),
  ].map((issue) => ({
    status: issue.status,
    scope: issue.scope,
    kind: issue.kind,
    ...(issue.recoverySystem ? { recoverySystem: issue.recoverySystem } : {}),
    quarantineId: issue.quarantineId,
    originalName: issue.originalName,
    quarantinedAt: issue.quarantinedAt,
    code: issue.code,
    message: issue.message,
    revision: issue.revision,
  })));
}

export function abandonInvalidContextHubSharedTransaction({
  quarantineId = "",
  expectedRevision = "",
} = {}) {
  const exactQuarantineId = String(quarantineId || "").trim();
  const exactRevision = String(expectedRevision || "").trim();
  if (!exactQuarantineId || !exactRevision) {
    const error = new Error("Exact quarantine ID and revision are required to abandon unreadable Shared recovery");
    error.code = "context_hub_shared_transaction_identity_required";
    error.statusCode = 400;
    throw error;
  }
  return withRegistryLock(() => {
    const issue = readInvalidHubSharedRecoveryIssuesLocked().find((entry) => entry.quarantineId === exactQuarantineId);
    if (!issue) {
      const sharedIssue = listSharedDisconnectRecoveryIssues().find((entry) => entry.quarantineId === exactQuarantineId);
      if (sharedIssue) {
        if (sharedIssue.revision !== exactRevision) {
          const error = new Error("The quarantined Shared disconnect recovery issue changed");
          error.code = "context_hub_shared_transaction_conflict";
          error.statusCode = 409;
          throw error;
        }
        const abandoned = abandonInvalidSharedDisconnectTransaction({
          quarantineId: exactQuarantineId,
          expectedRevision: exactRevision,
        });
        invalidateContextHubSnapshotLocked();
        return abandoned;
      }
      const error = new Error("The quarantined Context Hub Shared recovery issue no longer exists");
      error.code = "context_hub_shared_transaction_not_found";
      error.statusCode = 404;
      throw error;
    }
    if (issue.revision !== exactRevision) {
      const error = new Error("The quarantined Context Hub Shared recovery issue changed");
      error.code = "context_hub_shared_transaction_conflict";
      error.statusCode = 409;
      throw error;
    }
    const directory = ensurePrivateHubSharedTransactionDirectory(abandonedInvalidSharedTransactionDirectory());
    const archivedIssueDirectory = path.join(directory, issue.quarantineId);
    if (fs.existsSync(archivedIssueDirectory)) {
      throw Object.assign(new Error("This quarantined Context Hub Shared recovery issue was already archived"), { code: "context_hub_shared_transaction_conflict", statusCode: 409 });
    }
    invalidateContextHubSnapshotLocked();
    fs.renameSync(issue.issueDirectory, archivedIssueDirectory);
    let durabilityWarning = "";
    try {
      fsyncDirectory(directory);
      fsyncDirectory(invalidSharedTransactionDirectory());
      fsyncDirectory(sharedTransactionDirectory());
    } catch (error) {
      durabilityWarning = String(error?.message || error || "The invalid recovery archive directory could not be synchronized").slice(0, 500);
    }
    return {
      abandoned: true,
      quarantineId: issue.quarantineId,
      revision: issue.revision,
      scope: "global",
      archivedIssueDirectory,
      ...(durabilityWarning ? { durabilityWarning } : {}),
    };
  });
}

function writeHubSharedTransactionLocked(transaction) {
  const directory = sharedTransactionDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const filePath = path.join(directory, `${transaction.transactionId}.json`);
  writeJson(filePath, hubSharedTransactionPayload(transaction));
  return normalizedHubSharedTransaction(readJson(filePath), filePath);
}

function prepareHubSharedTransactionLocked(projectRoot, operation, requestedShared = null, {
  completionRequirement = "binding",
} = {}) {
  if (!isMainThread) {
    const error = new Error("Context Hub Shared transactions must be coordinated by the main server thread");
    error.code = "context_hub_shared_transaction_main_thread_required";
    error.statusCode = 409;
    throw error;
  }
  assertNoUnknownHubSharedRecoveryLocked();
  const registry = readContextHubRegistryRaw();
  const selected = registry.projects.find((entry) => entry.id === stableProjectId(projectRoot));
  if (!selected) throw new Error(`Context Hub project is not registered: ${projectRoot}`);
  const rootIdentity = normalizedProjectRootIdentity(selected.rootIdentity);
  if (!rootIdentity || path.resolve(selected.root) !== path.resolve(projectRoot)
    || !contextHubProjectRootMatchesIdentity(selected.root, rootIdentity)) {
    throw Object.assign(new Error("The Context Hub project root identity changed before its Shared transaction"), { code: "context_hub_shared_transaction_conflict" });
  }
  const logicalProjectId = selected.logicalProjectId || selected.id;
  const group = registry.projects.filter((entry) => (entry.logicalProjectId || entry.id) === logicalProjectId);
  if (group.length > MAX_HUB_SHARED_TRANSACTION_PROJECTS) {
    throw Object.assign(new Error("The Context Hub project has too many registered worktrees for one Shared transaction"), { code: "context_hub_shared_transaction_conflict" });
  }
  const projectGroup = group.map((entry) => {
    const groupRoot = path.resolve(entry.root);
    const groupRootIdentity = normalizedProjectRootIdentity(entry.rootIdentity);
    const worktreeIdentity = gitWorktreeIdentity(groupRoot);
    if (
      entry.id !== stableStoredProjectId(groupRoot)
      || !groupRootIdentity
      || !contextHubProjectRootMatchesIdentity(groupRoot, groupRootIdentity)
      || worktreeIdentity.logicalProjectId !== logicalProjectId
    ) {
      throw Object.assign(new Error("A Context Hub worktree identity changed before its Shared transaction"), { code: "context_hub_shared_transaction_conflict" });
    }
    return {
      id: entry.id,
      root: groupRoot,
      rootIdentity: groupRootIdentity,
      worktreeIdentity: worktreeIdentity.membershipIdentity,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const beforeShared = sharedStateForProject(selected);
  if (!group.every((entry) => sameSharedReference(sharedStateForProject(entry), beforeShared))) {
    throw Object.assign(new Error("Context Hub worktrees disagree about their Shared binding"), { code: "context_hub_shared_transaction_conflict" });
  }
  const shared = operation === "connect" ? normalizedSharedReference(requestedShared) : beforeShared;
  if (!shared) return null;
  if (operation === "connect" && beforeShared && !sameSharedReference(beforeShared, shared)) {
    throw Object.assign(new Error("Disconnect the current Shared binding before connecting another one"), { code: "shared_context_already_connected" });
  }
  const pending = readHubSharedTransactionsLocked().find((transaction) => transaction.logicalProjectId === logicalProjectId);
  if (pending) {
    throw Object.assign(new Error("This project already has a Shared transaction in progress"), { code: "context_hub_shared_transaction_busy" });
  }
  const transaction = writeHubSharedTransactionLocked({
    version: HUB_SHARED_TRANSACTION_VERSION,
    transactionId: randomUUID(),
    operation,
    ownerPid: process.pid,
    ownerThreadId: threadId,
    ownerProcessIdentity: processGenerationIdentity(process.pid),
    createdAt: new Date().toISOString(),
    projectRoot,
    rootIdentity,
    projectId: selected.id,
    logicalProjectId,
    projectGroup,
    completionRequirement,
    beforeShared: beforeShared ? { repository: beforeShared.repository, projectId: beforeShared.projectId } : null,
    shared: { repository: shared.repository, projectId: shared.projectId },
  });
  invalidateContextHubSnapshotLocked();
  return transaction;
}

function migrateLegacyContextHubRegistry(raw = {}) {
  if (Number(raw.version) >= CONTEXT_HUB_REGISTRY_VERSION) return raw;
  const candidates = (Array.isArray(raw.projects) ? raw.projects : []).map((entry) => {
    const root = path.resolve(String(entry?.root || ""));
    let rootIdentity = null;
    try {
      assertContextHubProjectControlFiles(root);
      rootIdentity = contextHubProjectRootIdentity(root);
    } catch {}
    let worktreeIdentity = null;
    let logicalProjectId = String(entry?.logicalProjectId || "");
    let worktree = entry?.worktree && typeof entry.worktree === "object" ? entry.worktree : null;
    if (rootIdentity) {
      try {
        const current = gitWorktreeIdentity(root, entry);
        if (!logicalProjectId) logicalProjectId = current.logicalProjectId;
        if (current.logicalProjectId === logicalProjectId) {
          worktreeIdentity = current.membershipIdentity;
          worktree = current.worktree;
        }
      } catch {}
    }
    return { entry, root, rootIdentity, logicalProjectId, worktree, worktreeIdentity };
  });
  const rootCounts = new Map();
  const identityCounts = new Map();
  for (const candidate of candidates) {
    const rootKey = stableStoredProjectId(candidate.root);
    rootCounts.set(rootKey, (rootCounts.get(rootKey) || 0) + 1);
    if (candidate.rootIdentity) {
      const identityKey = `${candidate.rootIdentity.dev}:${candidate.rootIdentity.ino}`;
      identityCounts.set(identityKey, (identityCounts.get(identityKey) || 0) + 1);
    }
  }
  return {
    ...raw,
    version: CONTEXT_HUB_REGISTRY_VERSION,
    projects: candidates.map(({ entry, root, rootIdentity, logicalProjectId, worktree, worktreeIdentity }) => {
      const rootKey = stableStoredProjectId(root);
      const identityKey = rootIdentity ? `${rootIdentity.dev}:${rootIdentity.ino}` : "";
      const unambiguous = rootIdentity
        && rootCounts.get(rootKey) === 1
        && identityCounts.get(identityKey) === 1;
      return {
        ...entry,
        root,
        rootIdentity: unambiguous ? rootIdentity : null,
        logicalProjectId: unambiguous ? logicalProjectId : entry.logicalProjectId,
        worktree: unambiguous ? worktree : entry.worktree,
        worktreeIdentity: unambiguous ? worktreeIdentity : null,
      };
    }),
  };
}

function normalizedRegistry(raw = {}, { refreshGit = false } = {}) {
  const projects = Array.isArray(raw.projects) ? raw.projects.flatMap((entry) => {
    try {
      const root = path.resolve(String(entry.root || ""));
      const storedRootIdentity = normalizedProjectRootIdentity(entry.rootIdentity);
      const rootAvailable = Boolean(storedRootIdentity)
        && contextHubProjectRootMatchesIdentity(root, storedRootIdentity);
      const rootIdentity = storedRootIdentity;
      const identity = refreshGit && rootAvailable ? gitWorktreeIdentity(root, entry) : {
        logicalProjectId: String(entry.logicalProjectId || stableStoredProjectId(root)),
        worktree: entry.worktree && typeof entry.worktree === "object" ? entry.worktree : null,
        membershipIdentity: normalizedWorktreeMembershipIdentity(entry.worktreeIdentity),
      };
      const registeredAt = String(entry.registeredAt || LEGACY_REGISTRY_TIMESTAMP);
      return [{
        id: stableStoredProjectId(root),
        logicalProjectId: identity.logicalProjectId,
        root,
        rootIdentity,
        title: cleanTitle(entry.title, rootAvailable && contextHubProjectControlFilesAreSafe(root) ? projectTitle(root) : path.basename(root) || "Local project"),
        registeredAt,
        lastOpenedAt: String(entry.lastOpenedAt || registeredAt),
        worktree: identity.worktree,
        worktreeIdentity: identity.membershipIdentity,
        shared: entry.shared && typeof entry.shared === "object" && entry.shared.repository && entry.shared.projectId ? {
          repository: canonicalRepositoryForStorage(entry.shared.repository),
          projectId: String(entry.shared.projectId).trim(),
        } : null,
      }];
    } catch {
      return [];
    }
  }) : [];
  const sharedRepositories = Array.isArray(raw.sharedRepositories) ? raw.sharedRepositories.flatMap((entry) => {
    try {
      return [{
        repository: canonicalRepositoryForStorage(entry.repository || entry),
        addedAt: String(entry.addedAt || LEGACY_REGISTRY_TIMESTAMP),
      }];
    } catch {
      return [];
    }
  }) : [];
  const repositoriesByIdentity = new Map();
  for (const entry of sharedRepositories) {
    const identity = repositoryIdentity(entry.repository);
    if (!repositoriesByIdentity.has(identity)) repositoriesByIdentity.set(identity, entry);
  }
  const normalizedProjects = projects.map((entry) => {
    if (!entry.shared) return entry;
    const identity = repositoryIdentity(entry.shared.repository);
    const canonical = repositoriesByIdentity.get(identity) || {
      repository: entry.shared.repository,
      addedAt: entry.registeredAt,
    };
    if (!repositoriesByIdentity.has(identity)) repositoriesByIdentity.set(identity, canonical);
    return { ...entry, shared: { ...entry.shared, repository: canonical.repository } };
  });
  return {
    version: CONTEXT_HUB_REGISTRY_VERSION,
    projects: [...new Map(normalizedProjects.map((entry) => [entry.id, entry])).values()],
    sharedRepositories: [...repositoriesByIdentity.values()],
  };
}

function readContextHubRegistryRaw({ refreshGit = false } = {}) {
  const raw = readJson(registryPath(), {});
  const migrated = migrateLegacyContextHubRegistry(raw);
  if (Number(raw?.version) < CONTEXT_HUB_REGISTRY_VERSION) {
    if (registryLockDepth <= 0) throw new Error("Context Hub registry migration requires its filesystem lock");
    writeJson(registryPath(), migrated);
  }
  return normalizedRegistry(migrated, { refreshGit });
}

export function readContextHubRegistry({ refreshGit = false } = {}) {
  if (registryLockDepth > 0) return readContextHubRegistryRaw({ refreshGit });
  return withRegistryLock(() => readContextHubRegistryRaw({ refreshGit }));
}

export function contextHubRegistryRevision(registry = readContextHubRegistry()) {
  return createHash("sha256").update(JSON.stringify(normalizedRegistry(registry))).digest("hex");
}

export function readContextHubSnapshotInputs() {
  return withRegistryLock(() => {
    const registry = readContextHubRegistry();
    return Object.freeze({
      registry,
      registryRevision: contextHubRegistryRevision(registry),
      invalidationRevision: readSnapshotControl().invalidationRevision,
    });
  });
}

export function beginContextHubSnapshotRefresh() {
  return withRegistryLock(() => {
    const control = readSnapshotControl();
    if (control.invalidationRevision === "initial") control.invalidationRevision = randomUUID();
    control.refreshSequence += 1;
    writeSnapshotControl(control);
    return Object.freeze({
      registryRevision: contextHubRegistryRevision(),
      invalidationRevision: control.invalidationRevision,
      refreshSequence: control.refreshSequence,
    });
  });
}

function readContextHubSnapshotLocked() {
  let snapshot = null;
  try {
    snapshot = readJson(contextHubSnapshotPath(), null);
    if (!snapshot?.registryRevision || snapshot.registryRevision !== contextHubRegistryRevision()) return null;
    if (!snapshot?.invalidationRevision || snapshot.invalidationRevision !== readSnapshotControl().invalidationRevision) return null;
  } catch {
    return null;
  }
  if (!snapshot || Number(snapshot.version) !== CONTEXT_HUB_SNAPSHOT_VERSION || !snapshot.state || typeof snapshot.state !== "object") return null;
  return snapshot;
}

export function readContextHubSnapshot() {
  return withRegistryLock(readContextHubSnapshotLocked);
}

export function writeContextHubSnapshot(state, {
  generatedAt = new Date().toISOString(),
  registryRevision = "",
} = {}) {
  return withRegistryLock(() => {
    const control = readSnapshotControl();
    const currentRegistryRevision = contextHubRegistryRevision();
    if (registryRevision && registryRevision !== currentRegistryRevision) return null;
    if (control.invalidationRevision === "initial") {
      control.invalidationRevision = randomUUID();
      writeSnapshotControl(control);
    }
    return writeJson(contextHubSnapshotPath(), {
      version: CONTEXT_HUB_SNAPSHOT_VERSION,
      registryRevision: currentRegistryRevision,
      invalidationRevision: control.invalidationRevision,
      refreshSequence: control.refreshSequence,
      generatedAt: String(generatedAt || new Date().toISOString()),
      state,
    });
  });
}

export function commitContextHubSnapshot(state, coordination, {
  generatedAt = state?.generatedAt || new Date().toISOString(),
} = {}) {
  return withRegistryLock(() => {
    const control = readSnapshotControl();
    const currentRegistryRevision = contextHubRegistryRevision();
    const refreshSequence = Number.parseInt(coordination?.refreshSequence, 10) || 0;
    if (!refreshSequence) return { committed: false, reason: "invalid-coordination" };
    if (
      coordination?.registryRevision !== currentRegistryRevision
      || coordination?.invalidationRevision !== control.invalidationRevision
    ) {
      return { committed: false, reason: "inputs-changed", currentRegistryRevision };
    }
    let currentSnapshot = null;
    try { currentSnapshot = readJson(contextHubSnapshotPath(), null); } catch {}
    const currentSequence = Number.parseInt(currentSnapshot?.refreshSequence, 10) || 0;
    if (
      currentSnapshot?.registryRevision === currentRegistryRevision
      && currentSnapshot?.invalidationRevision === control.invalidationRevision
      && currentSequence > refreshSequence
    ) {
      return { committed: false, reason: "out-of-order", currentRefreshSequence: currentSequence };
    }
    const snapshot = writeJson(contextHubSnapshotPath(), {
      version: CONTEXT_HUB_SNAPSHOT_VERSION,
      registryRevision: currentRegistryRevision,
      invalidationRevision: control.invalidationRevision,
      refreshSequence,
      generatedAt: String(generatedAt || new Date().toISOString()),
      state,
    });
    return { committed: true, snapshot };
  });
}

export function registerContextHubSharedRepository(repository) {
  const safeRepository = canonicalRepositoryForStorage(repository);
  const identity = repositoryIdentity(safeRepository);
  return mutateContextHubRegistry((registry) => {
    assertNoUnknownHubSharedRecoveryLocked();
    const existing = registry.sharedRepositories.find((entry) => repositoryIdentity(entry.repository) === identity);
    if (existing) return existing;
    const entry = { repository: safeRepository, addedAt: new Date().toISOString() };
    registry.sharedRepositories.push(entry);
    return entry;
  });
}

export function unregisterContextHubSharedRepository(repository) {
  const safeRepository = canonicalRepositoryForStorage(repository);
  const identity = repositoryIdentity(safeRepository);
  return mutateContextHubRegistry((registry) => {
    assertNoUnknownHubSharedRecoveryLocked();
    assertNoPendingHubSharedTransactionLocked(
      (transaction) => transaction.shared.repositoryIdentity === identity,
      "This shared repository has a project transaction in progress",
    );
    const connectedProjects = registry.projects.filter((entry) => entry.shared && repositoryIdentity(entry.shared.repository) === identity);
    if (connectedProjects.length) {
      const error = new Error("Disconnect every local project before removing this shared repository from Context Room");
      error.code = "shared_repository_in_use";
      error.details = { projectIds: connectedProjects.map((entry) => entry.id) };
      throw error;
    }
    const existing = registry.sharedRepositories.find((entry) => repositoryIdentity(entry.repository) === identity);
    registry.sharedRepositories = registry.sharedRepositories.filter((entry) => repositoryIdentity(entry.repository) !== identity);
    return { repository: existing?.repository || safeRepository, removed: Boolean(existing) };
  });
}

export function registerContextHubProject(root, { title = "", shared = null } = {}) {
  const projectRoot = stableRoot(root);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new Error(`Context Hub project root does not exist: ${projectRoot}`);
  assertContextHubProjectControlFiles(projectRoot);
  const id = stableProjectId(projectRoot);
  const identity = gitWorktreeIdentity(projectRoot);
  const rootIdentity = contextHubProjectRootIdentity(projectRoot);
  const requestedShared = shared?.repository && shared?.projectId ? {
    repository: canonicalRepositoryForStorage(shared.repository),
    projectId: String(shared.projectId).trim(),
  } : null;
  return mutateContextHubRegistry((registry) => registerContextHubProjectInRegistry(registry, {
    projectRoot,
    id,
    identity,
    rootIdentity,
    title,
    requestedShared,
  }));
}

function registerContextHubProjectInRegistry(registry, {
  projectRoot,
  id,
  identity,
  rootIdentity,
  title = "",
  requestedShared = null,
} = {}) {
  assertNoUnknownHubSharedRecoveryLocked();
  assertNoPendingHubSharedTransactionLocked((transaction) => transaction.logicalProjectId === identity.logicalProjectId);
  const existing = registry.projects.find((entry) => entry.id === id);
  const nextRootIdentity = normalizedProjectRootIdentity(rootIdentity) || contextHubProjectRootIdentity(projectRoot);
  const existingRootIdentity = normalizedProjectRootIdentity(existing?.rootIdentity);
  const sameRegisteredIdentity = Boolean(existing)
    && path.resolve(existing.root) === projectRoot
    && existingRootIdentity?.dev === nextRootIdentity.dev
    && existingRootIdentity?.ino === nextRootIdentity.ino
    && sameWorktreeMembershipIdentity(existing.worktreeIdentity, identity.membershipIdentity)
    && (existing.logicalProjectId || existing.id) === identity.logicalProjectId;
  const nextShared = requestedShared ? { ...requestedShared } : sameRegisteredIdentity ? existing.shared || null : null;
  if (nextShared) {
    const repositoryKey = repositoryIdentity(nextShared.repository);
    const existingRepository = registry.sharedRepositories.find((item) => repositoryIdentity(item.repository) === repositoryKey);
    nextShared.repository = existingRepository?.repository || nextShared.repository;
    if (!existingRepository) registry.sharedRepositories.push({ repository: nextShared.repository, addedAt: new Date().toISOString() });
  }
  const entry = {
    id,
    logicalProjectId: identity.logicalProjectId,
    root: projectRoot,
    rootIdentity: nextRootIdentity,
    title: cleanTitle(title, projectTitle(projectRoot)),
    registeredAt: sameRegisteredIdentity ? existing.registeredAt : new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    worktree: identity.worktree,
    worktreeIdentity: identity.membershipIdentity,
    shared: nextShared,
  };
  const logicalProjectId = entry.logicalProjectId || entry.id;
  registry.projects = [...registry.projects.filter((project) => project.id !== id), entry].map((project) => (
    entry.shared && (project.logicalProjectId || project.id) === logicalProjectId
      ? { ...project, shared: entry.shared }
      : project
  ));
  return entry;
}

export function withContextHubProjectSharedRegistration(root, {
  title = "",
  shared = null,
  requireSyncedShared = false,
} = {}, operation) {
  if (typeof operation !== "function") throw new TypeError("Context Hub project registration requires an operation");
  const projectRoot = stableRoot(root);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new Error(`Context Hub project root does not exist: ${projectRoot}`);
  assertContextHubProjectControlFiles(projectRoot);
  const id = stableProjectId(projectRoot);
  const identity = gitWorktreeIdentity(projectRoot);
  const rootIdentity = contextHubProjectRootIdentity(projectRoot);
  const requestedShared = shared?.repository && shared?.projectId ? {
    repository: canonicalRepositoryForStorage(shared.repository),
    projectId: String(shared.projectId).trim(),
  } : null;
  if (!requestedShared) throw new Error("Context Hub shared registration requires a repository and project ID");
  const transaction = withRegistryLock(() => prepareHubSharedTransactionLocked(projectRoot, "connect", requestedShared, {
    completionRequirement: requireSyncedShared ? "synced" : "binding",
  }));
  activeHubSharedTransactions.add(transaction.transactionId);
  try {
    const projectedProject = {
      id,
      logicalProjectId: identity.logicalProjectId,
      root: projectRoot,
      rootIdentity,
      title: cleanTitle(title, projectTitle(projectRoot)),
      shared: requestedShared,
      sharedTransactionId: transaction.transactionId,
      sharedProjectRoots: transaction.projectGroup.map((entry) => entry.root),
      sharedProjectCapabilities: transaction.projectGroup.map((entry) => ({
        root: entry.root,
        rootIdentity: entry.rootIdentity,
        worktreeIdentity: entry.worktreeIdentity,
      })),
    };
    const result = operation(projectedProject);
    const [resolution] = withRegistryLock(
      () => recoverContextHubSharedTransactionsLocked({ forceTransactionIds: new Set([transaction.transactionId]) }),
      { recoverSharedTransactions: false },
    );
    if (!resolution?.committed) {
      const error = new Error("Shared Context did not persist the exact requested binding");
      error.code = "context_hub_shared_transaction_incomplete";
      throw error;
    }
    const project = readContextHubRegistry().projects.find((entry) => entry.id === id) || projectedProject;
    return { project, result };
  } catch (error) {
    try {
      withRegistryLock(
        () => recoverContextHubSharedTransactionsLocked({ forceTransactionIds: new Set([transaction.transactionId]) }),
        { recoverSharedTransactions: false },
      );
    } catch (recoveryError) {
      error.contextHubRecoveryError = recoveryError;
    }
    throw error;
  } finally {
    activeHubSharedTransactions.delete(transaction.transactionId);
  }
}

export function unregisterContextHubProject(root) {
  const projectRoot = stableRoot(root);
  const projectId = stableProjectId(projectRoot);
  return mutateContextHubRegistry((registry) => {
    assertNoUnknownHubSharedRecoveryLocked();
    const current = registry.projects.find((entry) => entry.id === projectId);
    if (current) {
      const logicalProjectId = current.logicalProjectId || current.id;
      assertNoPendingHubSharedTransactionLocked((transaction) => transaction.logicalProjectId === logicalProjectId);
    }
    const removed = registry.projects.some((entry) => entry.id === projectId);
    if (removed) registry.projects = registry.projects.filter((entry) => entry.id !== projectId);
    return { projectId, removed };
  });
}

function disconnectContextHubProjectSharedInRegistry(registry, projectRoot) {
  const selected = registry.projects.find((entry) => entry.id === stableProjectId(projectRoot));
  if (!selected) throw new Error(`Context Hub project is not registered: ${projectRoot}`);
  const logicalProjectId = selected.logicalProjectId || selected.id;
  const sharedProjectRoots = registry.projects
    .filter((entry) => (entry.logicalProjectId || entry.id) === logicalProjectId)
    .map((entry) => entry.root);
  const sharedProjectCapabilities = registry.projects
    .filter((entry) => (entry.logicalProjectId || entry.id) === logicalProjectId)
    .map((entry) => ({
      root: entry.root,
      rootIdentity: entry.rootIdentity,
      worktreeIdentity: entry.worktreeIdentity,
    }));
  let changed = 0;
  registry.projects = registry.projects.map((entry) => {
    if ((entry.logicalProjectId || entry.id) !== logicalProjectId || !entry.shared) return entry;
    changed += 1;
    return { ...entry, shared: null };
  });
  return { projectId: selected.id, logicalProjectId, sharedProjectRoots, sharedProjectCapabilities, disconnectedLocations: changed };
}

export function disconnectContextHubProjectShared(root) {
  const projectRoot = stableRoot(root);
  return mutateContextHubRegistry((registry) => {
    assertNoUnknownHubSharedRecoveryLocked();
    const selected = registry.projects.find((entry) => entry.id === stableProjectId(projectRoot));
    if (selected) {
      const logicalProjectId = selected.logicalProjectId || selected.id;
      assertNoPendingHubSharedTransactionLocked((transaction) => transaction.logicalProjectId === logicalProjectId);
    }
    return disconnectContextHubProjectSharedInRegistry(registry, projectRoot);
  });
}

export function withContextHubProjectSharedDisconnection(root, operation) {
  if (typeof operation !== "function") throw new TypeError("Context Hub project disconnection requires an operation");
  const projectRoot = stableRoot(root);
  const transaction = withRegistryLock(() => prepareHubSharedTransactionLocked(projectRoot, "disconnect"));
  if (!transaction) {
    const disconnection = withRegistryLock(() => disconnectContextHubProjectSharedInRegistry(readContextHubRegistryRaw(), projectRoot));
    return { disconnection, result: operation(disconnection) };
  }
  activeHubSharedTransactions.add(transaction.transactionId);
  let before;
  try {
    before = readContextHubRegistry();
  } catch (error) {
    activeHubSharedTransactions.delete(transaction.transactionId);
    throw error;
  }
  const disconnection = {
    projectId: transaction.projectId,
    logicalProjectId: transaction.logicalProjectId,
    sharedProjectRoots: transaction.projectGroup.map((entry) => entry.root),
    sharedProjectCapabilities: transaction.projectGroup.map((entry) => ({
      root: entry.root,
      rootIdentity: entry.rootIdentity,
      worktreeIdentity: entry.worktreeIdentity,
    })),
    disconnectedLocations: before.projects.filter((entry) => (
      (entry.logicalProjectId || entry.id) === transaction.logicalProjectId && entry.shared
    )).length,
  };
  try {
    const result = operation(disconnection);
    const [resolution] = withRegistryLock(
      () => recoverContextHubSharedTransactionsLocked({ forceTransactionIds: new Set([transaction.transactionId]) }),
      { recoverSharedTransactions: false },
    );
    if (!resolution?.committed) {
      const error = new Error("Shared Context still owns the exact binding requested for disconnection");
      error.code = "context_hub_shared_transaction_incomplete";
      throw error;
    }
    return { disconnection, result };
  } catch (error) {
    try {
      withRegistryLock(
        () => recoverContextHubSharedTransactionsLocked({ forceTransactionIds: new Set([transaction.transactionId]) }),
        { recoverSharedTransactions: false },
      );
    } catch (recoveryError) {
      error.contextHubRecoveryError = recoveryError;
    }
    throw error;
  } finally {
    activeHubSharedTransactions.delete(transaction.transactionId);
  }
}

export function listContextHubProjects({ refreshGit = false } = {}) {
  return withRegistryLock(() => {
    const registry = readContextHubRegistryRaw({ refreshGit });
    const recoveryByLogicalProject = new Map(readHubSharedTransactionsLocked()
      .filter((transaction) => transaction.recoveryRequired)
      .map((transaction) => [transaction.logicalProjectId, {
        status: "recovery-required",
        transactionId: transaction.transactionId,
        operation: transaction.operation,
        projectId: transaction.projectId,
        logicalProjectId: transaction.logicalProjectId,
        createdAt: transaction.createdAt,
        detectedAt: transaction.recoveryRequired.detectedAt,
        message: transaction.recoveryRequired.message,
        previousShared: transaction.beforeShared ? {
          repository: transaction.beforeShared.repository,
          projectId: transaction.beforeShared.projectId,
        } : null,
        requestedShared: {
          repository: transaction.shared.repository,
          projectId: transaction.shared.projectId,
        },
      }]));
    const [unknownRecovery] = [
      ...readInvalidHubSharedRecoveryIssuesLocked(),
      ...peekSharedDisconnectRecoveryIssues(),
    ];
    const globalSharedRecovery = unknownRecovery ? {
      status: unknownRecovery.status,
      scope: unknownRecovery.scope,
      kind: unknownRecovery.kind,
      quarantineId: unknownRecovery.quarantineId,
      quarantinedAt: unknownRecovery.quarantinedAt,
      message: unknownRecovery.message,
      revision: unknownRecovery.revision,
    } : null;
    return registry.projects.map((entry) => {
      let available = false;
      try {
        const rootIdentity = normalizedProjectRootIdentity(entry.rootIdentity);
        available = Boolean(rootIdentity)
          && contextHubProjectRootMatchesIdentity(entry.root, rootIdentity)
          && assertContextHubProjectControlFiles(entry.root, rootIdentity);
      } catch {}
      const logicalProjectId = entry.logicalProjectId || entry.id;
      const sharedRecovery = recoveryByLogicalProject.get(logicalProjectId) || globalSharedRecovery;
      return {
        ...entry,
        available,
        title: available ? projectTitle(entry.root) : entry.title,
        ...(sharedRecovery ? { sharedRecovery } : {}),
      };
    }).sort((left, right) => {
      if (left.available !== right.available) return left.available ? -1 : 1;
      return String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt));
    });
  });
}

export function recordContextHubProjectOpened(projectId) {
  return mutateContextHubRegistry((registry) => {
    const project = registry.projects.find((entry) => entry.id === projectId);
    if (!project) throw new Error(`Unknown Context Hub project: ${projectId}`);
    project.lastOpenedAt = new Date().toISOString();
    return project;
  });
}

export function readContextHubRuntime() {
  const runtime = readJson(runtimePath(), null);
  if (!runtime || !Number.isInteger(Number(runtime.port)) || !runtime.url) return null;
  const port = Number(runtime.port);
  if (port < 1 || port > 65535) return null;
  return {
    pid: Number(runtime.pid) || null,
    port,
    root: runtime.root ? stableRoot(runtime.root) : "",
    url: `http://127.0.0.1:${port}`,
    startedAt: String(runtime.startedAt || ""),
  };
}

export function writeContextHubRuntime({ pid = process.pid, port, root, url } = {}) {
  const runtime = {
    version: 1,
    pid: Number(pid),
    port: Number(port),
    root: stableRoot(root),
    url: String(url),
    startedAt: new Date().toISOString(),
  };
  return withRegistryLock(() => writeJson(runtimePath(), runtime));
}

export function clearContextHubRuntime(pid = process.pid) {
  return withRegistryLock(() => {
    const runtime = readContextHubRuntime();
    if (!runtime || (pid && runtime.pid && Number(pid) !== runtime.pid)) return false;
    try {
      fs.unlinkSync(runtimePath());
      return true;
    } catch {
      return false;
    }
  });
}
