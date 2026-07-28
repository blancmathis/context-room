import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const CONTEXT_HUB_REGISTRY_VERSION = 2;
export const CONTEXT_HUB_SNAPSHOT_VERSION = 1;
export const CONTEXT_HUB_ATTENTION_VERSION = 1;

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
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  fs.chmodSync(filePath, 0o600);
  return value;
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

function writeContextHubAttention(next, { expectedRevision = "" } = {}) {
  const current = readContextHubAttention();
  if (expectedRevision && expectedRevision !== current.revision) {
    const error = new Error("Context Hub attention settings changed in another workspace");
    error.statusCode = 409;
    error.code = "attention_revision_conflict";
    error.details = { expectedRevision, currentRevision: current.revision };
    throw error;
  }
  const attention = normalizedAttention(next);
  writeJson(contextHubAttentionPath(), attention);
  return { ...attention, revision: attentionRevision(attention) };
}

export function setContextHubProjectOrder(projectOrder, { expectedRevision = "" } = {}) {
  const current = readContextHubAttention();
  return writeContextHubAttention({ ...current, projectOrder }, { expectedRevision });
}

export function setContextHubReviewSnoozes(entries = [], { expectedRevision = "" } = {}) {
  const current = readContextHubAttention();
  const snoozes = { ...current.snoozes };
  for (const entry of entries) {
    const reviewId = cleanAttentionId(entry?.reviewId);
    const revisionToken = cleanAttentionId(entry?.revisionToken);
    const until = String(entry?.until || "");
    if (!reviewId || !revisionToken || !Number.isFinite(Date.parse(until))) throw new Error("A review id, exact revision, and valid snooze deadline are required");
    snoozes[reviewId] = { reviewId, revisionToken, until: new Date(until).toISOString(), createdAt: new Date().toISOString() };
  }
  return writeContextHubAttention({ ...current, snoozes }, { expectedRevision });
}

export function removeContextHubReviewSnoozes(reviewIds = [], { expectedRevision = "" } = {}) {
  const current = readContextHubAttention();
  const snoozes = { ...current.snoozes };
  for (const reviewId of reviewIds.map(cleanAttentionId).filter(Boolean)) delete snoozes[reviewId];
  return writeContextHubAttention({ ...current, snoozes }, { expectedRevision });
}

function stableRoot(root) {
  const resolved = path.resolve(root);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function stableProjectId(root) {
  return createHash("sha256").update(stableRoot(root)).digest("hex").slice(0, 24);
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
  if (!gitRootValue || !commonDirValue) {
    return {
      logicalProjectId: String(previous?.logicalProjectId || stableProjectId(projectRoot)),
      worktree: previous?.worktree && typeof previous.worktree === "object" ? previous.worktree : null,
    };
  }
  const gitRoot = stableRoot(gitRootValue);
  const commonDir = stableRoot(path.resolve(gitRoot, commonDirValue));
  const relativeRoot = path.relative(gitRoot, projectRoot).replaceAll(path.sep, "/") || ".";
  const branch = gitText(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = gitText(projectRoot, ["rev-parse", "--short=12", "HEAD"]);
  const mainWorktree = path.basename(commonDir) === ".git" && stableRoot(path.dirname(commonDir)) === gitRoot;
  const logicalProjectId = createHash("sha256")
    .update(`git:${commonDir}\0${relativeRoot}`)
    .digest("hex")
    .slice(0, 24);
  return {
    logicalProjectId,
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
  try {
    const config = readJson(path.join(root, ".context-room", "config.json"), {});
    return cleanTitle(config.title, fallback);
  } catch {
    return fallback;
  }
}

function cleanRepository(value) {
  const repository = String(value || "").trim();
  if (!repository || /[\u0000\r\n]/.test(repository)) throw new Error("Shared repository URL is required");
  return repository;
}

function normalizedRegistry(raw = {}, { refreshGit = false } = {}) {
  const projects = Array.isArray(raw.projects) ? raw.projects.flatMap((entry) => {
    try {
      const root = stableRoot(entry.root);
      const identity = refreshGit && fs.existsSync(root) ? gitWorktreeIdentity(root, entry) : {
        logicalProjectId: String(entry.logicalProjectId || stableProjectId(root)),
        worktree: entry.worktree && typeof entry.worktree === "object" ? entry.worktree : null,
      };
      const registeredAt = String(entry.registeredAt || new Date().toISOString());
      return [{
        id: stableProjectId(root),
        logicalProjectId: identity.logicalProjectId,
        root,
        title: cleanTitle(entry.title, projectTitle(root)),
        registeredAt,
        lastOpenedAt: String(entry.lastOpenedAt || registeredAt),
        worktree: identity.worktree,
        shared: entry.shared && typeof entry.shared === "object" && entry.shared.repository && entry.shared.projectId ? {
          repository: cleanRepository(entry.shared.repository),
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
        repository: cleanRepository(entry.repository || entry),
        addedAt: String(entry.addedAt || new Date().toISOString()),
      }];
    } catch {
      return [];
    }
  }) : [];
  return {
    version: CONTEXT_HUB_REGISTRY_VERSION,
    projects: [...new Map(projects.map((entry) => [entry.id, entry])).values()],
    sharedRepositories: [...new Map(sharedRepositories.map((entry) => [entry.repository, entry])).values()],
  };
}

export function readContextHubRegistry({ refreshGit = false } = {}) {
  return normalizedRegistry(readJson(registryPath(), {}), { refreshGit });
}

export function readContextHubSnapshot() {
  let snapshot = null;
  try {
    snapshot = readJson(contextHubSnapshotPath(), null);
  } catch {
    return null;
  }
  if (!snapshot || Number(snapshot.version) !== CONTEXT_HUB_SNAPSHOT_VERSION || !snapshot.state || typeof snapshot.state !== "object") return null;
  return snapshot;
}

export function writeContextHubSnapshot(state, { generatedAt = new Date().toISOString() } = {}) {
  return writeJson(contextHubSnapshotPath(), {
    version: CONTEXT_HUB_SNAPSHOT_VERSION,
    generatedAt: String(generatedAt || new Date().toISOString()),
    state,
  });
}

export function registerContextHubSharedRepository(repository) {
  const safeRepository = cleanRepository(repository);
  const registry = readContextHubRegistry();
  const existing = registry.sharedRepositories.find((entry) => entry.repository === safeRepository);
  registry.sharedRepositories = [
    ...registry.sharedRepositories.filter((entry) => entry.repository !== safeRepository),
    { repository: safeRepository, addedAt: existing?.addedAt || new Date().toISOString() },
  ];
  writeJson(registryPath(), registry);
  return registry.sharedRepositories.at(-1);
}

export function registerContextHubProject(root, { title = "", shared = null } = {}) {
  const projectRoot = stableRoot(root);
  const configPath = path.join(projectRoot, ".context-room", "config.json");
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new Error(`Context Hub project root does not exist: ${projectRoot}`);
  if (!fs.existsSync(configPath)) throw new Error(`Context Hub project is not initialized: ${configPath}`);
  const registry = readContextHubRegistry();
  const id = stableProjectId(projectRoot);
  const identity = gitWorktreeIdentity(projectRoot);
  const existing = registry.projects.find((entry) => entry.id === id);
  const entry = {
    id,
    logicalProjectId: identity.logicalProjectId,
    root: projectRoot,
    title: cleanTitle(title, projectTitle(projectRoot)),
    registeredAt: existing?.registeredAt || new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    worktree: identity.worktree,
    shared: shared?.repository && shared?.projectId ? {
      repository: cleanRepository(shared.repository),
      projectId: String(shared.projectId).trim(),
    } : existing?.shared || null,
  };
  registry.projects = [...registry.projects.filter((project) => project.id !== id), entry];
  if (entry.shared) {
    const existingRepository = registry.sharedRepositories.find((item) => item.repository === entry.shared.repository);
    registry.sharedRepositories = [
      ...registry.sharedRepositories.filter((item) => item.repository !== entry.shared.repository),
      { repository: entry.shared.repository, addedAt: existingRepository?.addedAt || new Date().toISOString() },
    ];
  }
  writeJson(registryPath(), registry);
  return entry;
}

export function listContextHubProjects({ refreshGit = false } = {}) {
  const registry = readContextHubRegistry({ refreshGit });
  return registry.projects.map((entry) => {
    let available = false;
    try {
      available = fs.statSync(entry.root).isDirectory()
        && fs.existsSync(path.join(entry.root, ".context-room", "config.json"));
    } catch {}
    return {
      ...entry,
      available,
      title: available ? projectTitle(entry.root) : entry.title,
    };
  }).sort((left, right) => {
    if (left.available !== right.available) return left.available ? -1 : 1;
    return String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt));
  });
}

export function recordContextHubProjectOpened(projectId) {
  const registry = readContextHubRegistry();
  const project = registry.projects.find((entry) => entry.id === projectId);
  if (!project) throw new Error(`Unknown Context Hub project: ${projectId}`);
  project.lastOpenedAt = new Date().toISOString();
  writeJson(registryPath(), registry);
  return project;
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
  return writeJson(runtimePath(), {
    version: 1,
    pid: Number(pid),
    port: Number(port),
    root: stableRoot(root),
    url: String(url),
    startedAt: new Date().toISOString(),
  });
}

export function clearContextHubRuntime(pid = process.pid) {
  const runtime = readContextHubRuntime();
  if (!runtime || (pid && runtime.pid && Number(pid) !== runtime.pid)) return false;
  try {
    fs.unlinkSync(runtimePath());
    return true;
  } catch {
    return false;
  }
}
