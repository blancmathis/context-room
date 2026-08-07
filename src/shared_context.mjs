import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { parse as parseJsonc } from "jsonc-parser";
import { appendContextRoomEvent } from "./event_journal.mjs";
import { gitHubAppGitEnvironment } from "./github_app_token.mjs";
import { parseDocMetadata } from "./doc_metadata.mjs";
import { contextProviderProfile } from "./provider_profiles.mjs";
import { inspectOwnerProposalDecisions, inspectOwnerTrustedState, recordOwnerProposalDecision } from "./review_authority.mjs";

export const SHARED_REPOSITORY_CONFIG = ".context-room/shared-repository.json";
export const SHARED_REVIEW_CONFIG = ".context-room/shared-review.json";
export const SHARED_REPOSITORY_SCHEMA_VERSION = 1;
export const SHARED_SKILL_LOCATIONS_SCHEMA_VERSION = 1;
export const SHARED_RESOURCE_LOCAL_STATE_VERSION = 3;
export const SHARED_SKILL_LOCAL_STATE_VERSION = SHARED_RESOURCE_LOCAL_STATE_VERSION;
export const SHARED_INSTRUCTION_LOCATIONS_SCHEMA_VERSION = 1;
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

function runGit(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding === null ? null : "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
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
    if (parsed.username || parsed.password) throw new Error("repository URLs must not contain embedded credentials");
  }
  return repository;
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
    if (seen.has(id)) throw new Error(`Duplicate shared project id: ${id}`);
    seen.add(id);
    const source = item?.source && typeof item.source === "object" ? {
      remotes: [...new Set((item.source.remotes || []).map((remote) => normalizeRemote(safeRepository(remote))).filter(Boolean))],
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
    if (repositoryConfig && collectionPath === repositoryConfig.skillLocationsFile) {
      throw new Error(`Skill collection ${id} cannot use skillLocationsFile`);
    }
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
    if (collectionPath === ".context-room" || collectionPath.startsWith(".context-room/")) throw new Error(`Instruction collection ${id} must stay outside .context-room runtime state`);
    if (repositoryConfig && [repositoryConfig.instructionLocationsFile, repositoryConfig.skillLocationsFile, repositoryConfig.projectsFile].some((reserved) => pathsOverlap(collectionPath, reserved))) {
      throw new Error(`Instruction collection ${id} overlaps a reserved shared manifest`);
    }
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

function normalizeRemote(value) {
  let remote = String(value || "").trim().replace(/\.git$/, "");
  const scp = remote.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) remote = `${scp[1]}/${scp[2]}`;
  else remote = remote.replace(/^[a-z]+:\/\//i, "").replace(/^([^/]+@)?/, "");
  return remote.replace(/^github\.com\//i, "github.com/").toLowerCase();
}

function sourceIdentity(root) {
  const resolved = stableRoot(root);
  const topLevel = tryGit(resolved, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return null;
  const remotes = tryGit(topLevel, ["remote"]).split("\n").filter(Boolean)
    .flatMap((name) => tryGit(topLevel, ["remote", "get-url", "--all", name]).split("\n"))
    .map(normalizeRemote).filter(Boolean);
  if (!remotes.length) return null;
  const stableTopLevel = stableRoot(topLevel);
  const sourceSubpath = path.relative(stableTopLevel, resolved).replaceAll(path.sep, "/") || ".";
  return { topLevel: stableTopLevel, remotes: [...new Set(remotes)], sourceSubpath };
}

function stableRoot(root) {
  const resolved = path.resolve(root);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function bindingMatchesSource(binding, source) {
  const bindingRemotes = [...new Set([...(binding.sourceRemotes || []), binding.sourceRemote].filter(Boolean).map(normalizeRemote))];
  if (!source || !source.remotes.some((remote) => bindingRemotes.includes(remote))) return false;
  const bindingPath = String(binding.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const sourcePath = String(source.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return bindingPath === "." || sourcePath === bindingPath || sourcePath.startsWith(bindingPath + "/");
}

function registerSourceBinding(root, connection) {
  const source = sourceIdentity(root);
  const registry = readJson(registryPath(), { version: 1, bindings: [] });
  const registeredRoot = stableRoot(root);
  const previous = (registry.bindings || []).find((item) => (
    source
      ? String(item.sourceSubpath || ".") === source.sourceSubpath
        && [...new Set([...(item.sourceRemotes || []), item.sourceRemote].filter(Boolean).map(normalizeRemote))].some((remote) => source.remotes.includes(remote))
      : item.sourceRoot && stableRoot(item.sourceRoot) === registeredRoot
  ));
  const binding = source ? {
    repository: connection.repository,
    projectId: connection.projectId,
    sourceRemotes: source.remotes,
    sourceSubpath: source.sourceSubpath,
    projectRoots: [...new Set([...(previous?.projectRoots || []), registeredRoot])],
  } : {
    repository: connection.repository,
    projectId: connection.projectId,
    sourceRoot: registeredRoot,
    projectRoots: [...new Set([...(previous?.projectRoots || []), registeredRoot])],
  };
  registry.bindings = [...(registry.bindings || []).filter((item) => !(
    source
      ? String(item.sourceSubpath || ".") === binding.sourceSubpath
        && [...new Set([...(item.sourceRemotes || []), item.sourceRemote].filter(Boolean).map(normalizeRemote))].some((remote) => source.remotes.includes(remote))
      : item.sourceRoot && stableRoot(item.sourceRoot) === binding.sourceRoot
  )), binding];
  writeJson(registryPath(), registry);
  return binding;
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
    }).sort((left, right) => String(right.sourceRoot || "").length - String(left.sourceRoot || "").length);
    const binding = matches[0];
    return binding ? {
      version: 1,
      repository: safeRepository(binding.repository),
      projectId: safeId(binding.projectId, "projectId"),
      projectRoot: stableRoot(binding.sourceRoot),
    } : null;
  }
  const matches = (registry.bindings || []).filter((binding) => bindingMatchesSource(binding, source));
  matches.sort((left, right) => String(right.sourceSubpath || ".").length - String(left.sourceSubpath || ".").length);
  const binding = matches[0];
  if (!binding) return null;
  const sourceSubpath = String(binding.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const projectRoot = sourceSubpath === "." ? source.topLevel : path.join(source.topLevel, ...sourceSubpath.split("/"));
  return {
    version: 1,
    repository: safeRepository(binding.repository),
    projectId: safeId(binding.projectId, "projectId"),
    projectRoot: stableRoot(projectRoot),
  };
}

function registeredProjectRoots(connection) {
  const repository = safeRepository(connection.repository);
  const projectId = safeId(connection.projectId, "projectId");
  const registry = readJson(registryPath(), { bindings: [] });
  return [...new Set((registry.bindings || [])
    .filter((binding) => safeRepository(binding.repository) === repository && String(binding.projectId || "") === projectId)
    .flatMap((binding) => binding.projectRoots || (binding.sourceRoot ? [binding.sourceRoot] : []))
    .map(stableRoot)
    .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()))];
}

function registeredRepositoryProjectLocations(repository) {
  const safeRemote = safeRepository(repository);
  const registry = readJson(registryPath(), { bindings: [] });
  const locations = (registry.bindings || []).filter((binding) => safeRepository(binding.repository) === safeRemote)
    .flatMap((binding) => (binding.projectRoots || (binding.sourceRoot ? [binding.sourceRoot] : [])).map((root) => ({ projectId: safeId(binding.projectId, "projectId"), root: stableRoot(root) })))
    .filter((item) => fs.existsSync(item.root) && fs.statSync(item.root).isDirectory());
  return [...new Map(locations.map((item) => [`${item.projectId}:${item.root}`, item])).values()]
    .sort((left, right) => `${left.projectId}:${left.root}`.localeCompare(`${right.projectId}:${right.root}`, "en"));
}

export function listRegisteredSharedProjectLocations(repository) {
  return registeredRepositoryProjectLocations(repository);
}

function repositoryCacheRoot(repository) {
  return path.join(sharedHome(), hashKey(repository));
}

function repositoryCheckout(repository) {
  return path.join(repositoryCacheRoot(repository), "repository");
}

function sharedStatePath(repository) {
  return path.join(repositoryCacheRoot(repository), "state.json");
}

function syncSharedRepositoryState(repository, { allowOffline = true } = {}) {
  const safeRemote = safeRepository(repository);
  const checkout = ensureRepositoryClone(safeRemote);
  let fetchError = "";
  try {
    runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    fetchError = String(error.stderr || error.message || error).trim();
    if (!allowOffline) throw new Error(`Unable to refresh shared context: ${fetchError}`);
  }
  const state = readJson(sharedStatePath(safeRemote), {});
  let descriptor;
  try {
    descriptor = readRemoteSharedDescriptor(checkout, state.defaultBranch || "");
  } catch (error) {
    if (!fetchError || !state.revision || !state.repositoryConfig || !state.catalog) throw error;
    descriptor = {
      revision: safeRevision(state.revision, "cached shared revision"),
      config: normalizedRepositoryConfig(state.repositoryConfig),
      catalog: normalizedProjectsCatalog(state.catalog),
    };
  }
  assertSafeTreeEntries(checkout, descriptor.revision, []);
  const cacheRoot = repositoryCacheRoot(safeRemote);
  const snapshot = path.join(cacheRoot, "snapshots", descriptor.revision);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  materializeSnapshot(checkout, descriptor.revision, snapshot);
  const repositoryConfig = readSharedRepositoryConfig(snapshot);
  const catalog = normalizedProjectsCatalog(readJson(path.join(snapshot, repositoryConfig.projectsFile)));
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
  writeJson(sharedStatePath(safeRemote), nextState);
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

function cachedSharedRepositoryState(repository, { projectId = "global", projectRoot = "" } = {}) {
  const safeRemote = safeRepository(repository);
  const state = readJson(sharedStatePath(safeRemote), {});
  if (!state.revision || !state.repositoryConfig || !state.catalog) {
    return syncSharedRepositoryState(safeRemote, { allowOffline: true });
  }
  const revision = safeRevision(state.revision, "cached shared revision");
  const repositoryConfig = normalizedRepositoryConfig(state.repositoryConfig);
  const catalog = normalizedProjectsCatalog(state.catalog);
  const checkout = ensureRepositoryClone(safeRemote);
  if (!gitObjectExists(checkout, `${revision}^{commit}`)) {
    return syncSharedRepositoryState(safeRemote, { allowOffline: true });
  }
  const cacheRoot = repositoryCacheRoot(safeRemote);
  const snapshot = path.join(cacheRoot, "snapshots", revision);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  materializeSnapshot(checkout, revision, snapshot);
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

function ensureRepositoryClone(repository) {
  const checkout = repositoryCheckout(repository);
  if (fs.existsSync(path.join(checkout, ".git"))) {
    configureExistingSharedAgentGit(repository, checkout);
    return checkout;
  }
  if (fs.existsSync(checkout)) throw new Error(`Shared cache path already exists and is not a Git clone: ${checkout}`);
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  runGit(path.dirname(checkout), ["clone", "--origin", "origin", "--no-checkout", repository, checkout], { stdio: ["ignore", "ignore", "pipe"] });
  configureExistingSharedAgentGit(repository, checkout);
  return checkout;
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
  let config = normalizedRepositoryConfig(JSON.parse(runGit(checkout, ["show", `${revision}:${SHARED_REPOSITORY_CONFIG}`])));
  if (config.defaultBranch !== bootstrapBranch) {
    const selectedBranch = config.defaultBranch;
    revision = remoteRevision(checkout, selectedBranch);
    config = normalizedRepositoryConfig(JSON.parse(runGit(checkout, ["show", `${revision}:${SHARED_REPOSITORY_CONFIG}`])));
    if (config.defaultBranch !== selectedBranch) throw new Error("Shared defaultBranch must be stable across the selected branch");
  }
  const catalog = normalizedProjectsCatalog(JSON.parse(runGit(checkout, ["show", `${revision}:${config.projectsFile}`])));
  return { revision, config, catalog };
}

function sharedContextError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
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
  const reviewedDependencyPaths = new Set(dependencyProofResult.proof?.documents.map((item) => item.path) || []);
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
    dependencyProofError: dependencyProofResult.error,
    dependencyReviewRequired,
    acceptance,
    acceptanceError,
  };
}

function resolveSharedMainRevision(repository, { refresh = true } = {}) {
  const safeRemote = safeRepository(repository);
  const checkout = ensureRepositoryClone(safeRemote);
  if (refresh) {
    try {
      runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      throw sharedContextError("shared-freshness-unverified", `Unable to verify the accepted shared revision: ${String(error.stderr || error.message || error).trim()}`, { repository: safeRemote });
    }
  }
  let descriptor;
  try {
    descriptor = readRemoteSharedDescriptor(checkout, readJson(sharedStatePath(safeRemote), {}).defaultBranch || "");
  } catch (error) {
    throw sharedContextError("shared-main-unavailable", error.message, { repository: safeRemote });
  }
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

export function readSharedMainRevision(repository, options = {}) {
  const { checkout: _checkout, ...main } = resolveSharedMainRevision(repository, options);
  return main;
}

export function diffSharedMainRevisions(repository, { fromRevision, toRevision = "", projectId = "", refresh = false } = {}) {
  const main = resolveSharedMainRevision(repository, { refresh });
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
  const records = splitNull(runGit(checkout, ["diff", "--name-status", "-z", "-M", "-C", "--find-copies-harder", `${fromRevision}..${toRevision}`, "--"], { encoding: null }));
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

function remoteProposalBranchesAtRevision(checkout, repositoryConfig, revision) {
  const proposalRefPrefix = `refs/remotes/origin/${repositoryConfig.proposalPrefix}`;
  return tryGit(checkout, ["for-each-ref", "--points-at", revision, "--format=%(refname:strip=3)", proposalRefPrefix])
    .split("\n")
    .filter(Boolean)
    .map((branch) => safeBranchName(branch, "proposal branch"));
}

export function diffSharedProposalRevisions(repository, { fromRevision, toRevision, refresh = true } = {}) {
  const main = resolveSharedMainRevision(repository, { refresh });
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

export function readSharedRevisionDocuments(repository, revision, { refresh = true } = {}) {
  const main = resolveSharedMainRevision(repository, { refresh });
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
  const locations = readSharedSkillLocationsFromRevision(checkout, revision, repositoryConfig, catalog);
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

export function diffSharedSkillLocationsRevisions(repository, { fromRevision, toRevision, refresh = true } = {}) {
  const main = resolveSharedMainRevision(repository, { refresh });
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

export function detectSharedProject(root, { repository, projectId = "" } = {}) {
  const resolvedRoot = stableRoot(root);
  const safeRemote = safeRepository(repository);
  const checkout = ensureRepositoryClone(safeRemote);
  runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
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
  const project = matches[0];
  if (!project) throw new Error("No shared project matches this Git remote and repository subpath; pass --project explicitly");
  const projectRoot = project.source.subpath === "."
    ? source.topLevel
    : path.join(source.topLevel, ...project.source.subpath.split("/"));
  return { projectId: project.id, projectRoot: stableRoot(projectRoot), repository: safeRemote, revision: descriptor.revision };
}

function materializeSnapshot(checkout, revision, destination) {
  if (fs.existsSync(path.join(destination, SHARED_REPOSITORY_CONFIG))) return destination;
  const cacheRoot = path.dirname(path.dirname(destination));
  const temporary = path.join(cacheRoot, `snapshot-${revision.slice(0, 12)}-${process.pid}.tmp`);
  fs.mkdirSync(temporary, { recursive: true });
  try {
    const archive = runGit(checkout, ["archive", "--format=tar", revision], { encoding: null });
    const extracted = spawnSync("tar", ["-xf", "-", "-C", temporary], { input: archive, encoding: "utf8" });
    if (extracted.status !== 0) throw new Error(extracted.stderr || "Unable to extract shared context snapshot");
    fs.renameSync(temporary, destination);
    makeTreeReadOnly(destination);
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
  fs.writeFileSync(filePath, snapshot.content, { mode: snapshot.mode });
  fs.chmodSync(filePath, snapshot.mode);
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

function archiveAcceptedInstructionImports(plan, connection, root) {
  if (!plan.preferences.pendingInstructionImports.length) return [];
  const checkout = repositoryCheckout(connection.repository);
  const acceptedRevision = path.basename(plan.currentRoot || "");
  const completed = [];
  const remaining = [];
  for (const pending of plan.preferences.pendingInstructionImports) {
    const accepted = pending.proposalHead && Boolean(tryGit(checkout, ["log", "-n", "1", "--format=%H", "--fixed-strings", `--grep=Context-Room-Proposal-Head: ${pending.proposalHead}`, acceptedRevision || "origin/main"]));
    if (!accepted) {
      if (remoteBranchRevision(checkout, pending.proposal)) remaining.push(pending);
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

function reconcileInstructionLinks(root, connection, repositoryConfig, currentRoot, catalog, { includeDevice = true, providers = null } = {}) {
  const plan = resolvedInstructionLinkPlan(root, connection, repositoryConfig, catalog, currentRoot, { includeDevice, providers });
  const completedImports = archiveAcceptedInstructionImports(plan, connection, root);
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

function archiveAcceptedSkillImports(plan, connection) {
  if (!plan.preferences.pendingImports.length) return [];
  const collectionById = new Map(plan.collections.map((collection) => [collection.id, collection]));
  const completed = [];
  const remaining = [];
  const checkout = repositoryCheckout(connection.repository);
  const acceptedRevision = path.basename(plan.currentRoot || "");
  for (const pending of plan.preferences.pendingImports) {
    const accepted = pending.proposalHead && Boolean(tryGit(checkout, ["log", "-n", "1", "--format=%H", "--fixed-strings", `--grep=Context-Room-Proposal-Head: ${pending.proposalHead}`, acceptedRevision || "origin/main"]));
    if (!accepted) {
      if (!remoteBranchRevision(checkout, pending.proposal)) continue;
      remaining.push(pending);
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
  const collectionPaths = (skillLocations?.collections || []).map((collection) => homeVirtualPath(path.join(currentRoot, collection.path), true));
  const instructionCollectionPaths = (instructionLocations?.collections || []).map((collection) => homeVirtualPath(path.join(currentRoot, collection.path), true));
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
      ...(skillLocations && !skillLocations.legacy ? skillLocations.collections.map((collection) => ({ id: `shared-skill-collection-${collection.id}`, title: collection.title, path: homeVirtualPath(path.join(currentRoot, collection.path), true), description: `Accepted shared skill collection · ${collection.id}.` })) : []),
      ...(instructionLocations ? instructionLocations.collections.map((collection) => ({ id: `shared-instruction-collection-${collection.id}`, title: collection.title, path: homeVirtualPath(path.join(currentRoot, collection.path), true), description: `Accepted shared instruction collection · ${collection.id}.` })) : []),
    ],
  };
  config.hubSections = [...(config.hubSections || []).filter((item) => item?.id !== section.id), section];
  config.sharedContext = { enabled: true, projectId: connection.projectId, repository: connection.repository };
  writeJson(configPath, config);
  return { updated: true, configPath, paths: { docs, projectSkills, globalSkills } };
}

function syncSkillLinks(root, connection, repositoryConfig, currentRoot, catalog, { providers = null } = {}) {
  const plan = resolvedSkillLinkPlan(root, connection, repositoryConfig, catalog, currentRoot);
  const completedImports = archiveAcceptedSkillImports(plan, connection);
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

function sharedBindingForRoot(root, connection, registry) {
  const source = sourceIdentity(root);
  const candidates = (registry.bindings || []).filter((binding) => {
    try {
      if (safeRepository(binding.repository) !== connection.repository || String(binding.projectId || "") !== connection.projectId) return false;
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

function detachManagedRegistryLinks(registryFile, { repository, managedRoot, pathKey, keep = () => false } = {}) {
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
    const state = managedSymlinkTarget(link, managedRoot);
    const owner = managedDestinationOwner(link);
    if (!state.symbolic || !state.managed || owner?.repository !== repository) {
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
  writePrivateJson(registryFile, { ...registry, links: retained, destinations: (registry.destinations || []).filter((item) => keep(item)) });
  return detached;
}

function removeSharedContextFromProjectConfig(root, connection) {
  const configPath = path.join(root, ".context-room", "config.json");
  if (!fs.existsSync(configPath)) return null;
  const previous = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(previous);
  let configuredRepository = "";
  try { configuredRepository = config.sharedContext?.repository ? safeRepository(config.sharedContext.repository) : ""; }
  catch { return { configPath, previous, changed: false }; }
  if (!config.sharedContext || configuredRepository !== connection.repository || String(config.sharedContext.projectId || "") !== connection.projectId) return { configPath, previous, changed: false };
  const managedPrefix = homeVirtualPath(path.join(repositoryCacheRoot(connection.repository), "current"), true);
  const keepUnmanaged = (value) => !String(value || "").startsWith(managedPrefix);
  config.allowedPaths = (config.allowedPaths || []).filter(keepUnmanaged);
  config.readOnlyPaths = (config.readOnlyPaths || []).filter(keepUnmanaged);
  config.hubSections = (config.hubSections || []).filter((section) => section?.id !== "shared-context");
  delete config.sharedContext;
  writeJson(configPath, config);
  return { configPath, previous, changed: true };
}

export function disconnectSharedContext(root) {
  const resolvedRoot = stableRoot(root);
  const connection = readSharedProjectConnection(resolvedRoot);
  if (!connection) return { disconnected: false, reason: "not-connected" };
  const registry = readJson(registryPath(), { version: 1, bindings: [] });
  const binding = sharedBindingForRoot(resolvedRoot, connection, registry);
  if (!binding) throw new Error("The selected shared-context binding is no longer registered");
  const remainingBindings = (registry.bindings || []).filter((candidate) => candidate !== binding);
  const keepRepositoryDeviceLinks = remainingBindings.some((candidate) => {
    try { return safeRepository(candidate.repository) === connection.repository; } catch { return false; }
  });
  const projectRoots = [...new Set([...(binding.projectRoots || []), binding.sourceRoot, connection.projectRoot, resolvedRoot].filter(Boolean).map(stableRoot))];
  const managedRoot = repositoryCacheRoot(connection.repository);
  const detached = [];
  const changedConfigs = [];
  try {
    for (const projectRoot of projectRoots) {
      const skillRegistry = skillLinkRegistryPath(connection.repository, projectRoot);
      detached.push(...detachManagedRegistryLinks(skillRegistry, {
        repository: connection.repository,
        managedRoot,
        pathKey: "link",
        keep: (item) => item.scope === "device" && keepRepositoryDeviceLinks,
      }));
      const instructionRegistry = instructionLinkRegistryPath(connection.repository, projectRoot, "project");
      detached.push(...detachManagedRegistryLinks(instructionRegistry, {
        repository: connection.repository,
        managedRoot,
        pathKey: "destination",
      }));
      const config = removeSharedContextFromProjectConfig(projectRoot, connection);
      if (config?.changed) changedConfigs.push(config);
    }
    if (!keepRepositoryDeviceLinks) {
      detached.push(...detachManagedRegistryLinks(instructionLinkRegistryPath(connection.repository, resolvedRoot, "device"), {
        repository: connection.repository,
        managedRoot,
        pathKey: "destination",
      }));
    }
    writeJson(registryPath(), { ...registry, bindings: remainingBindings });
    return {
      disconnected: true,
      connection,
      projectRoots,
      removedManagedLinks: detached.length,
    };
  } catch (error) {
    restoreDetachedSkillLinks(detached);
    for (const config of changedConfigs) {
      try { fs.writeFileSync(config.configPath, config.previous, "utf8"); } catch {}
    }
    writeJson(registryPath(), registry);
    throw error;
  }
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

export function connectSharedContext(root, { repository, projectId, sync = true } = {}) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) throw new Error(`Project root does not exist: ${resolvedRoot}`);
  const safeRemote = safeRepository(repository);
  const detected = detectSharedProject(resolvedRoot, { repository: safeRemote, projectId });
  const bindingRoot = detected.projectRoot;
  const connection = { version: 1, repository: safeRemote, projectId: detected.projectId, projectRoot: bindingRoot };
  const previousRegistry = readJson(registryPath(), { version: 1, bindings: [] });
  registerSourceBinding(bindingRoot, connection);
  if (!sync) return { connection, connected: true };
  try {
    return syncSharedContext(bindingRoot);
  } catch (error) {
    writeJson(registryPath(), previousRegistry);
    throw error;
  }
}

export function syncSharedContext(root, { allowOffline = true, forceReconcile = false, providers = null } = {}) {
  const resolvedRoot = path.resolve(root);
  const connection = readSharedProjectConnection(resolvedRoot);
  if (!connection) throw new Error("This project has no approved shared-context binding; run context-room shared setup first");
  const localProjectRoot = connection.projectRoot || resolvedRoot;
  registerSourceBinding(localProjectRoot, { ...connection, projectRoot: localProjectRoot });
  const checkout = ensureRepositoryClone(connection.repository);
  let fetchError = "";
  try {
    runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    fetchError = String(error.stderr || error.message || error).trim();
    if (!allowOffline) throw new Error(`Unable to refresh shared context: ${fetchError}`);
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
    if (!fetchError || !state.revision || !state.repositoryConfig) throw error;
    revision = state.revision;
    repositoryConfig = normalizedRepositoryConfig(state.repositoryConfig);
    catalog = state.catalog
      ? normalizedProjectsCatalog(state.catalog)
      : normalizedProjectsCatalog(JSON.parse(runGit(checkout, ["show", `${revision}:${repositoryConfig.projectsFile}`])));
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
  const current = path.join(cacheRoot, "current");
  const previousCurrent = (() => {
    try { return fs.lstatSync(current).isSymbolicLink() ? path.resolve(path.dirname(current), fs.readlinkSync(current)) : ""; } catch { return ""; }
  })();
  const configPath = path.join(localProjectRoot, ".context-room", "config.json");
  const previousConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
  let installedSharedContext = null;
  if (previousConfig !== null) {
    try { installedSharedContext = JSON.parse(previousConfig).sharedContext || null; } catch {}
  }
  const switchingSharedContext = installedSharedContext?.repository && (
    safeRepository(installedSharedContext.repository) !== connection.repository
    || installedSharedContext.projectId !== connection.projectId
  );
  let detachedSkillLinks = [];
  let links;
  let instructionLinks;
  let room;
  const revisionChanged = previousRevision !== revision;
  const reconcileLocation = (locationRoot, locationConnection, skillLocations) => {
    const registryFile = skillLinkRegistryPath(connection.repository, locationRoot);
    const existing = readJson(registryFile, null);
    if (!forceReconcile && !revisionChanged && existing?.revision === revision) {
      const plan = resolvedSkillLinkPlan(locationRoot, locationConnection, repositoryConfig, catalog, snapshot);
      return { ...plan, links: existing.links || [], destinations: existing.destinations || [], migrations: [], completedImports: [], skipped: true };
    }
    return syncSkillLinks(locationRoot, locationConnection, repositoryConfig, snapshot, catalog, { providers });
  };
  try {
    if (switchingSharedContext) detachedSkillLinks = detachInstalledSkillLinks(localProjectRoot, installedSharedContext);
    replaceSymlink(current, snapshot, { managedRoot: cacheRoot });
    const skillLocations = readSharedSkillLocationsFromRoot(snapshot, repositoryConfig, catalog);
    const instructionLocations = readSharedInstructionLocationsFromRoot(snapshot, repositoryConfig, catalog);
    room = configureProjectRoom(localProjectRoot, connection, repositoryConfig, current, skillLocations, instructionLocations);
    links = reconcileLocation(localProjectRoot, connection, skillLocations);
    instructionLinks = reconcileInstructionLinks(localProjectRoot, connection, repositoryConfig, snapshot, catalog, { includeDevice: true, providers });
    for (const location of registeredRepositoryProjectLocations(connection.repository)) {
      if (location.projectId === connection.projectId && stableRoot(location.root) === stableRoot(localProjectRoot)) continue;
      try {
        configureProjectRoom(location.root, { ...connection, projectId: location.projectId, projectRoot: location.root }, repositoryConfig, current, skillLocations, instructionLocations);
        reconcileLocation(location.root, { ...connection, projectId: location.projectId, projectRoot: location.root }, skillLocations);
        const reconciledInstructions = reconcileInstructionLinks(location.root, { ...connection, projectId: location.projectId, projectRoot: location.root }, repositoryConfig, snapshot, catalog, { includeDevice: false, providers });
        instructionLinks.links.push(...reconciledInstructions.links);
      } catch (error) {
        links.destinations.push({ id: `worktree:${hashKey(location.root).slice(0, 12)}`, assignmentId: "", collectionId: "", provider: "", scope: "project", destination: location.root, skills: [], links: [], status: "worktree-error", message: `Unable to reconcile registered worktree: ${error.message}`, conflicts: [] });
      }
    }
  } catch (error) {
    restoreDetachedSkillLinks(detachedSkillLinks);
    if (previousCurrent) {
      try { replaceSymlink(current, previousCurrent, { managedRoot: cacheRoot }); } catch {}
    } else {
      const currentState = managedSymlinkTarget(current, cacheRoot);
      if (currentState.symbolic && currentState.managed) {
        try { fs.unlinkSync(current); } catch {}
      }
    }
    if (previousConfig !== null) {
      try { fs.writeFileSync(configPath, previousConfig, "utf8"); } catch {}
    }
    throw error;
  }
  const nextState = {
    version: 1,
    repository: connection.repository,
    defaultBranch: repositoryConfig.defaultBranch,
    revision,
    syncedAt: new Date().toISOString(),
    online: !fetchError,
    fetchError,
    repositoryConfig,
    catalog,
  };
  writeJson(sharedStatePath(connection.repository), nextState);
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

export function readAcceptedSharedMetadataProfiles(root) {
  const status = sharedContextStatus(root);
  if (!status.connected || !status.cacheRoot || !status.revision) return [];
  const snapshot = path.join(status.cacheRoot, "snapshots", status.revision);
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
          ? [{ ...definition, origin: "shared", filePath: `.context-room/profiles/${entry.name}`, sharedRevision: status.revision }]
          : [];
      } catch {
        return [{ id: `invalid-shared-profile-${entry.name}`, schemaVersion: "context-room.metadata-profile/1", version: "invalid", match: ["**/*"], origin: "shared", filePath: `.context-room/profiles/${entry.name}`, sharedRevision: status.revision, invalidSource: true }];
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
  const normalized = normalizedSharedSkillLocations({ ...current, collections: current.collections.map((item) => ({ ...item })), assignments: current.assignments.filter((item) => item.id !== preview.assignment.id) }, { repositoryConfig, catalog });
  writeJson(path.join(proposal.root, repositoryConfig.skillLocationsFile), sharedSkillLocationsDocument(normalized));
  const published = publishSharedProposal(root, { proposal: proposal.branch, title, description, message: title });
  return { proposal: published, assignment: preview.assignment, action: "unassign", localFilesChanged: false };
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
      const checkout = ensureRepositoryClone(connection.repository);
      runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
      repositoryConfig = readRemoteSharedDescriptor(checkout).config;
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
  const prefix = rejected ? config.rejectionPrefix : config.proposalPrefix;
  return {
    name: githubReviewRulesetName(kind),
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: [githubPrefixPattern(prefix)], exclude: [] } },
    rules: rejected
      ? [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }]
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
  const checks = {
    active: ruleset?.enforcement === "active",
    branchTarget: ruleset?.target === "branch",
    exactPattern: ruleset?.conditions?.ref_name?.include?.includes(githubPrefixPattern(rejected ? config.rejectionPrefix : config.proposalPrefix)) === true,
    noBypassActors: Array.isArray(ruleset?.bypass_actors) && ruleset.bypass_actors.length === 0,
    blocksDeletion: types.has("deletion"),
    ...(rejected ? { blocksForcePush: types.has("non_fast_forward"), blocksUpdates: types.has("update") } : {}),
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
  const mainInspected = inspectGitHubRuleset(mainRuleset, repositoryConfig.defaultBranch);
  const proposalInspected = inspectGitHubReviewRuleset(proposalRuleset, repositoryConfig, "proposal");
  const rejectedInspected = inspectGitHubReviewRuleset(rejectedRuleset, repositoryConfig, "rejected");
  const deployKeys = runGitHubApi(`repos/${github.fullName}/keys?per_page=100`);
  const agentGit = inspectSharedAgentGit(repository, github, gitRoots, deployKeys);
  const checks = {
    ...prefixedChecks("main", mainInspected.checks),
    ...prefixedChecks("proposal", proposalInspected.checks),
    ...prefixedChecks("rejected", rejectedInspected.checks),
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
      locations = readSharedSkillLocationsFromRoot(options.root, config, catalog);
    }
    if (!locations && options.checkout && options.revision) {
      const catalog = options.catalog || normalizedProjectsCatalog(JSON.parse(String(runGit(options.checkout, ["show", `${options.revision}:${config.projectsFile}`]))));
      locations = readSharedSkillLocationsFromRevision(options.checkout, options.revision, config, catalog);
    }
    return (locations?.collections || []).map((collection) => collection.path.replace(/\/$/, "") + "/");
  }
  if (scope === "instructions") {
    let locations = options.instructionLocations || null;
    if (!locations && options.root) {
      const catalog = options.catalog || normalizedProjectsCatalog(readJson(path.join(options.root, config.projectsFile)));
      locations = readSharedInstructionLocationsFromRoot(options.root, config, catalog);
    }
    if (!locations && options.checkout && options.revision) {
      const catalog = options.catalog || normalizedProjectsCatalog(JSON.parse(String(runGit(options.checkout, ["show", `${options.revision}:${config.projectsFile}`]))));
      const manifest = `${options.revision}:${config.instructionLocationsFile}`;
      locations = gitObjectExists(options.checkout, manifest)
        ? normalizedSharedInstructionLocations(JSON.parse(String(runGit(options.checkout, ["show", manifest]))), { repositoryConfig: config, catalog })
        : emptySharedInstructionLocations();
    }
    return (locations?.collections || []).map((collection) => collection.path.replace(/\/$/, "") + "/");
  }
  if (scope !== "project") throw new Error("Proposal scope must be project, global, skills, or instructions");
  const projectRoot = `${config.projectsPath.replace(/\/$/, "")}/${safeId(projectId, "projectId")}`;
  return [`${projectRoot}/docs/`, `${projectRoot}/skills/`];
}

function proposalIdentity(config, branch, options = {}) {
  const safeBranch = safeBranchName(branch, "proposal branch");
  if (!safeBranch.startsWith(config.proposalPrefix)) throw new Error(`Proposal branch must start with ${config.proposalPrefix}`);
  const suffix = safeBranch.slice(config.proposalPrefix.length);
  const segments = suffix.split("/");
  if (segments.length < 2 || !segments.slice(1).join("/")) throw new Error("Proposal branch must include a scope and proposal name");
  const scopeId = safeId(segments[0], "proposal scope");
  const scope = scopeId === "global" ? "global" : scopeId === "skills" ? "skills" : scopeId === "instructions" ? "instructions" : "project";
  return {
    branch: safeBranch,
    projectId: scopeId,
    scope,
    allowedExact: scope === "skills" ? [config.skillLocationsFile] : scope === "instructions" ? [config.instructionLocationsFile] : [],
    allowedPrefixes: proposalScopePrefixes(config, scopeId, scope, options),
  };
}

function assertPathsInProposalScope(files, policy) {
  const outside = files.filter((file) => !(policy.allowedExact || []).includes(file) && !policy.allowedPrefixes.some((prefix) => file.startsWith(prefix)));
  if (!outside.length) return;
  if (policy.scope === "project") throw new Error(`Proposal changes files outside ${policy.allowedPrefixes.join(" or ")}: ${outside.join(", ")}`);
  if (policy.scope === "global") throw new Error(`Proposal changes files outside ${policy.allowedPrefixes.join(" or ")}: ${outside.join(", ")}`);
  throw new Error(`Proposal changes files outside its allowed shared manifest or collections: ${outside.join(", ")}`);
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
  return `${config.proposalPrefix}${scopeId}/${stamp}-${slug}`;
}

function proposalRegistryPath(repository) {
  return path.join(repositoryCacheRoot(repository), "proposals.json");
}

function proposalObservationsPath(repository) {
  return path.join(repositoryCacheRoot(repository), "proposal-observations.json");
}

function proposalDecisionAuthorityOptions() {
  return { authorityHome: path.join(sharedHome(), "review-authority") };
}

function observedProposalValue(item, state = "active") {
  return {
    branch: String(item.branch || ""),
    projectId: String(item.projectId || ""),
    scope: String(item.scope || "project"),
    repository: String(item.repository || ""),
    repositoryName: String(item.repositoryName || ""),
    projectTitle: String(item.projectTitle || ""),
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
  const state = readJson(proposalObservationsPath(repository), { version: 1, repository, proposals: {} });
  if (state?.version !== 1 || state?.repository !== repository || !state.proposals || typeof state.proposals !== "object") {
    return { version: 1, repository, proposals: {} };
  }
  return state;
}

function writeProposalObservations(repository, state) {
  return writePrivateJson(proposalObservationsPath(repository), {
    version: 1,
    repository,
    proposals: state.proposals || {},
    updatedAt: new Date().toISOString(),
  });
}

function rememberProposalObservation(repository, item, state = "active") {
  const observations = readProposalObservations(repository);
  observations.proposals[item.branch] = observedProposalValue(item, state);
  writeProposalObservations(repository, observations);
}

function sharedProjectRepositoryState(repository, projectId) {
  const synced = syncSharedRepositoryState(repository, { allowOffline: false });
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

function createSharedProposalFromState(synced, { sourceRoot = "", title, description = "", scope = "project", branch = "", sessionId = process.env.CODEX_THREAD_ID || "" } = {}) {
  const { connection, repositoryConfig, revision } = synced;
  const safeTitle = proposalTitle(title);
  const safeDescription = proposalDescription(description);
  const proposal = proposalBranch(repositoryConfig, connection.projectId, safeTitle, scope, branch);
  const checkout = repositoryCheckout(connection.repository);
  const proposalRoot = path.join(repositoryCacheRoot(connection.repository), "proposals", hashKey(proposal));
  if (fs.existsSync(proposalRoot)) throw new Error(`Proposal workspace already exists: ${proposalRoot}`);
  runGit(checkout, ["worktree", "add", "-b", proposal, proposalRoot, revision], { stdio: ["ignore", "ignore", "pipe"] });
  const resolvedSourceRoot = connection.projectRoot || (sourceRoot ? path.resolve(sourceRoot) : "");
  const source = resolvedSourceRoot ? sourceIdentity(resolvedSourceRoot) : null;
  const sourceCommit = resolvedSourceRoot ? tryGit(resolvedSourceRoot, ["rev-parse", "HEAD"]) : "";
  const sourceBranch = resolvedSourceRoot ? tryGit(resolvedSourceRoot, ["branch", "--show-current"]) : "";
  const registry = readJson(proposalRegistryPath(connection.repository), { version: 1, proposals: {} });
  registry.proposals[proposal] = {
    branch: proposal,
    root: proposalRoot,
    baseRevision: revision,
    projectId: connection.projectId,
    scope,
    title: safeTitle,
    description: safeDescription,
    sourceRemote: source?.remotes?.[0] || "",
    sourceBranch,
    sourceCommit: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sourceCommit) ? sourceCommit : "",
    sessionId: safeSessionId(sessionId),
    createdAt: new Date().toISOString(),
  };
  writeJson(proposalRegistryPath(connection.repository), registry);
  return registry.proposals[proposal];
}

export function createSharedProposal(root, options = {}) {
  return createSharedProposalFromState(syncSharedContext(root, { allowOffline: false }), { ...options, sourceRoot: root });
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

export function ensureSharedProposal(root, { title, description = "", scope = "project", branch = "", sessionId = process.env.CODEX_THREAD_ID || "" } = {}) {
  const normalizedSession = safeSessionId(sessionId);
  if (!normalizedSession || branch) {
    return { ...createSharedProposal(root, { title, description, scope, branch, sessionId: normalizedSession }), reused: false };
  }
  const synced = syncSharedContext(root, { allowOffline: false });
  const { connection } = synced;
  const registryFile = proposalRegistryPath(connection.repository);
  const registry = readJson(registryFile, { version: 1, proposals: {} });
  const checkout = repositoryCheckout(connection.repository);
  const remoteProposals = listRemoteSharedProposals(synced);
  const terminalBranches = new Set(remoteProposals
    .filter((proposal) => ["accepted", "merged"].includes(proposal.reviewStatus))
    .map((proposal) => proposal.branch));
  const localMatches = Object.values(registry.proposals || {}).filter((entry) => (
    proposalSessionMatches(entry, connection, scope, normalizedSession)
    && fs.existsSync(entry.root)
    && !terminalBranches.has(entry.branch)
    && (!entry.lastPublishedHead || remoteBranchRevision(checkout, entry.branch))
  ));
  const remoteMatches = remoteProposals.filter((proposal) => (
    proposalSessionMatches(proposal, connection, scope, normalizedSession)
    && !["accepted", "merged"].includes(proposal.reviewStatus)
  ));
  const matches = new Map();
  for (const entry of localMatches) matches.set(entry.branch, { kind: "local", entry });
  for (const proposal of remoteMatches) matches.set(proposal.branch, { kind: "remote", proposal });
  if (matches.size > 1) {
    throw new Error(`Several open proposals match session ${normalizedSession} and scope ${proposalScopeId(connection, scope)}: ${[...matches.keys()].join(", ")}`);
  }
  const match = [...matches.values()][0];
  if (!match) {
    return { ...createSharedProposal(root, { title, description, scope, sessionId: normalizedSession }), reused: false };
  }
  if (match.kind === "local") return { ...match.entry, reused: true };
  const proposalRoot = ensureProposalWorktree(checkout, connection.repository, match.proposal);
  const entry = proposalRegistryEntryFromRemote(match.proposal, proposalRoot);
  registry.proposals[entry.branch] = entry;
  writeJson(registryFile, registry);
  return { ...entry, reused: true };
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
  const registry = readJson(proposalRegistryPath(connection.repository), { proposals: {} });
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
  const registry = readJson(proposalRegistryPath(connection.repository), { version: 1, proposals: {} });
  const normalizedSession = safeSessionId(sessionId);
  return Object.values(registry.proposals || {}).flatMap((entry) => {
    if (!entry?.branch || !entry?.root || !fs.existsSync(entry.root)) return [];
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

export function openSharedProposalWorkspace(root, { proposal } = {}) {
  const synced = syncSharedContext(root, { allowOffline: false });
  const { connection, repositoryConfig } = synced;
  const branch = safeBranchName(String(proposal || "").trim(), "proposal branch");
  proposalIdentity(repositoryConfig, branch);
  const registryFile = proposalRegistryPath(connection.repository);
  const registry = readJson(registryFile, { version: 1, proposals: {} });
  const checkout = repositoryCheckout(connection.repository);
  const remote = listRemoteSharedProposals(synced).find((entry) => entry.branch === branch) || null;
  if (remote && ["accepted", "merged"].includes(remote.reviewStatus)) {
    throw new Error(`Proposal is already ${remote.reviewStatus}: ${branch}`);
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
  registry.proposals ||= {};
  registry.proposals[branch] = { ...entry, updatedAt: new Date().toISOString() };
  writeJson(registryFile, registry);
  return {
    ...registry.proposals[branch],
    head,
    dirty: Boolean(tryGit(entry.root, ["status", "--porcelain=v1"])),
    conflict: Boolean(tryGit(entry.root, ["diff", "--name-only", "--diff-filter=U"])),
    reviewStatus: remote?.reviewStatus || "editing",
    reused: true,
  };
}

function changedFiles(cwd, base) {
  const committed = gitChangedPaths(cwd, `${base}...HEAD`);
  const working = splitNull(runGit(cwd, ["diff", "--name-only", "-z", "HEAD", "--"], { encoding: null }));
  const untracked = splitNull(runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"], { encoding: null }));
  return [...new Set([...committed, ...working, ...untracked])];
}

function publishSharedProposalFromState(synced, { proposal, message = "", title, description, author = null } = {}) {
  const { connection, entry, registry } = proposalEntryForConnection(synced.connection, proposal);
  const commitEnv = author?.name && author?.email ? {
    GIT_AUTHOR_NAME: String(author.name),
    GIT_AUTHOR_EMAIL: String(author.email),
    GIT_COMMITTER_NAME: String(author.name),
    GIT_COMMITTER_EMAIL: String(author.email),
  } : {};
  const config = readSharedRepositoryConfig(entry.root);
  const identity = proposalIdentity(config, entry.branch, { root: entry.root });
  const expectedScopeId = ["global", "skills", "instructions"].includes(entry.scope) ? entry.scope : entry.projectId;
  if (identity.projectId !== expectedScopeId) throw new Error(`Proposal branch scope must be ${config.proposalPrefix}${expectedScopeId}/`);
  const previousRemoteHead = tryGit(entry.root, ["rev-parse", "--verify", `refs/remotes/origin/${entry.branch}`]);
  if (previousRemoteHead && description === undefined) {
    throw new Error("--description is required whenever a published proposal is updated");
  }
  const nextTitle = proposalTitle(title === undefined ? entry.title : title);
  const nextDescription = proposalDescription(description === undefined ? entry.description : description, { optional: !previousRemoteHead });
  const pendingFiles = changedFiles(entry.root, entry.baseRevision);
  assertPathsInProposalScope(pendingFiles, identity);
  if (!pendingFiles.length) throw new Error("Proposal has no changes");
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
    const commitArgs = ["commit"];
    if (!hasStagedChanges) commitArgs.push("--allow-empty");
    commitArgs.push("-m", proposalCommitMessage(entry, message));
    runGit(entry.root, commitArgs, { stdio: ["ignore", "ignore", "pipe"], env: commitEnv });
  }
  const unmerged = tryGit(entry.root, ["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged) {
    entry.conflict = { status: "conflict", mainRevision: synced.revision, files: unmerged.split("\n").filter(Boolean), updatedAt: new Date().toISOString() };
    writeJson(proposalRegistryPath(connection.repository), registry);
    throw new Error(`Proposal rebase conflict remains unresolved: ${entry.conflict.files.join(", ")}`);
  }
  const previousBaseRevision = entry.baseRevision;
  const rebased = synced.revision !== previousBaseRevision;
  if (rebased) {
    try {
      runGit(entry.root, ["rebase", "--onto", synced.revision, previousBaseRevision, entry.branch], { stdio: ["ignore", "ignore", "pipe"], env: commitEnv });
    } catch (error) {
      const files = tryGit(entry.root, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
      entry.conflict = { status: "conflict", mainRevision: synced.revision, files, updatedAt: new Date().toISOString() };
      writeJson(proposalRegistryPath(connection.repository), registry);
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
  const files = gitChangedPaths(entry.root, `${entry.baseRevision}...${head}`);
  assertPathsInProposalScope(files, identity);
  assertReviewableChangedPaths(entry.root, entry.baseRevision, head, files);
  const pushArgs = ["push", "--set-upstream"];
  if (previousRemoteHead && rebased) pushArgs.push(`--force-with-lease=refs/heads/${entry.branch}:${previousRemoteHead}`);
  pushArgs.push("origin", `${entry.branch}:${entry.branch}`);
  runGit(entry.root, pushArgs, { stdio: ["ignore", "ignore", "pipe"] });
  entry.updatedAt = new Date().toISOString();
  entry.lastPublishedHead = head;
  writeJson(proposalRegistryPath(connection.repository), registry);
  rememberProposalObservation(connection.repository, {
    ...identity,
    repository: connection.repository,
    repositoryName: synced.repositoryConfig.name,
    projectTitle: synced.catalog.projects.find((project) => project.id === identity.projectId)?.title || identity.projectId,
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
    projectId: connection.projectId,
    sharedRepository: connection.repository,
    resource: { proposal: entry.branch, files },
    data: { head, baseRevision: entry.baseRevision, semanticReviewRequired: Boolean(entry.semanticReviewRequired) },
  });
  return { ...entry, head, files, rebased };
}

export function publishSharedProposal(root, options = {}) {
  return publishSharedProposalFromState(syncSharedContext(root, { allowOffline: false }), options);
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

export function proposeSharedDocumentationFile(repository, { projectId, path: requestedPath, title, description, sessionId = "" } = {}) {
  const safeTitle = proposalTitle(title, "New shared document");
  const safeDescription = proposalDescription(description, { optional: false });
  const suggestedPath = sharedDocumentSlug(safeTitle) + ".md";
  let documentPath = safeRelativePath(requestedPath || suggestedPath, "shared document path");
  const extension = path.posix.extname(documentPath);
  if (!extension) documentPath += ".md";
  else if (extension.toLowerCase() !== ".md") throw new Error("shared documents must use the .md extension");
  if (documentPath.split("/").some((segment) => segment.startsWith("."))) {
    throw new Error("shared document path must not use hidden files or folders");
  }
  const synced = sharedProjectRepositoryState(repository, projectId);
  const repositoryPath = safeRelativePath(
    `${synced.repositoryConfig.projectsPath}/${synced.connection.projectId}/docs/${documentPath}`,
    "shared document repository path",
  );
  const acceptedTarget = path.join(synced.snapshot, ...repositoryPath.split("/"));
  if (fs.existsSync(acceptedTarget)) throw new Error(`Shared document already exists: ${repositoryPath}`);
  const proposal = createSharedProposalFromState(synced, {
    title: `Create ${safeTitle}`,
    description: safeDescription,
    scope: "project",
    sessionId,
  });
  const target = path.join(proposal.root, ...repositoryPath.split("/"));
  if (fs.existsSync(target)) throw new Error(`Shared document already exists: ${repositoryPath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, sharedMarkdownTemplate(synced.connection.projectId, documentPath, safeTitle), "utf8");
  const published = publishSharedProposalFromState(synced, {
    proposal: proposal.branch,
    title: proposal.title,
    description: safeDescription,
    message: `Create shared document ${documentPath}`,
    author: { name: "Context Room", email: ["context-room", "local.invalid"].join("@") },
  });
  return {
    repository: synced.connection.repository,
    projectId: synced.connection.projectId,
    repositoryPath,
    documentPath,
    proposal: published,
  };
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
    const safeRemote = safeRepository(repository);
    const checkout = ensureRepositoryClone(safeRemote);
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
    synced = {
      connection: { repository: safeRemote, projectId: "global", projectRoot: "" },
      repositoryConfig,
      catalog,
      revision: frozenRevision,
      online: Boolean(state.online),
      fetchError: String(state.fetchError || ""),
      cacheRoot,
      snapshot,
    };
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
  const skillLocations = readSharedSkillLocationsFromRoot(synced.snapshot, synced.repositoryConfig, synced.catalog);
  for (const collection of skillLocations.collections) addRoot(collection.path);
  const instructionLocations = readSharedInstructionLocationsFromRoot(synced.snapshot, synced.repositoryConfig, synced.catalog);
  for (const collection of instructionLocations.collections) addRoot(collection.path);
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
  const checkout = repositoryCheckout(repository);
  const config = readSharedRepositoryConfig(path.join(repositoryCacheRoot(repository), "snapshots", acceptedRevision));
  const catalog = normalizedProjectsCatalog(JSON.parse(String(runGit(checkout, ["show", `${acceptedRevision}:${config.projectsFile}`]))));
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
  return [...new Set((registry.bindings || []).flatMap((binding) => {
    try { return [safeRepository(binding.repository)]; } catch { return []; }
  }))];
}

export function listRegisteredSharedBindings(repository = "") {
  const selectedRepository = repository ? safeRepository(repository) : "";
  const registry = readJson(registryPath(), { bindings: [] });
  return (registry.bindings || []).flatMap((binding) => {
    try {
      const bindingRepository = safeRepository(binding.repository);
      if (selectedRepository && bindingRepository !== selectedRepository) return [];
      return [{
        repository: bindingRepository,
        projectId: safeId(binding.projectId, "projectId"),
        sourceRoot: binding.sourceRoot ? stableRoot(binding.sourceRoot) : "",
        sourceSubpath: String(binding.sourceSubpath || "."),
        projectRoots: [...new Set((binding.projectRoots || []).map(stableRoot))],
      }];
    } catch {
      return [];
    }
  });
}

export function listSharedRepositoryProposals(repository, { allowOffline = true, refresh = true } = {}) {
  const synced = refresh
    ? syncSharedRepositoryState(repository, { allowOffline })
    : cachedSharedRepositoryState(repository);
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
}

export function rejectSharedRepositoryProposal(repository, { proposal, expectedHead, actor = "human-ui" } = {}) {
  const synced = syncSharedRepositoryState(repository, { allowOffline: false });
  const identity = proposalIdentity(synced.repositoryConfig, proposal);
  const reviewedHead = safeRevision(expectedHead, "expected proposal head");
  const current = listRemoteSharedProposals(synced).find((item) => item.branch === identity.branch);
  if (!current) throw new Error(`Remote proposal not found: ${identity.branch}`);
  if (current.head !== reviewedHead) {
    throw new Error("Proposal changed before rejection; refresh and review the current exact revision");
  }
  if (["accepted", "merged"].includes(current.reviewStatus)) {
    throw new Error("An accepted proposal cannot be rejected from the active review queue");
  }

  const checkout = repositoryCheckout(synced.connection.repository);
  const registryFile = proposalRegistryPath(synced.connection.repository);
  const registry = readJson(registryFile, { version: 1, proposals: {} });
  const localEntry = registry.proposals?.[identity.branch];
  if (localEntry?.root && fs.existsSync(localEntry.root)) {
    const pending = tryGit(localEntry.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (pending) {
      throw new Error("Proposal has unpublished local changes; publish or resolve them before rejecting it");
    }
  }

  const proposalSuffix = identity.branch.slice(synced.repositoryConfig.proposalPrefix.length);
  const rejectionBranch = safeBranchName(
    `${synced.repositoryConfig.rejectionPrefix}${proposalSuffix}-${reviewedHead.slice(0, 12)}`,
    "rejection branch",
  );
  const existingArchiveHead = remoteBranchRevision(checkout, rejectionBranch);
  if (existingArchiveHead && existingArchiveHead !== reviewedHead) {
    throw new Error(`Rejected proposal archive does not match the exact proposal revision: ${rejectionBranch}`);
  }
  if (!existingArchiveHead) {
    runGit(checkout, [
      "push",
      "origin",
      `${reviewedHead}:refs/heads/${rejectionBranch}`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
  }

  recordOwnerProposalDecision(synced.connection.repository, {
    proposal: identity.branch,
    proposalHead: reviewedHead,
    decision: "rejected",
    archiveRef: rejectionBranch,
  }, { ...proposalDecisionAuthorityOptions(), actor });

  if (localEntry?.root && fs.existsSync(localEntry.root)) {
    try {
      runGit(checkout, ["worktree", "remove", localEntry.root], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {}
  }
  if (registry.proposals?.[identity.branch]) {
    delete registry.proposals[identity.branch];
    writeJson(registryFile, registry);
  }
  runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
  rememberProposalObservation(synced.connection.repository, current, "rejected");
  const result = {
    rejected: true,
    repository: synced.connection.repository,
    proposal: identity.branch,
    proposalHead: reviewedHead,
    rejectionBranch,
  };
  appendContextRoomEvent("proposal.rejected", {
    projectId: identity.projectId,
    sharedRepository: synced.connection.repository,
    resource: { proposal: identity.branch, proposalHead: reviewedHead, rejectionBranch },
  });
  return result;
}

function gitIsAncestor(cwd, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, encoding: "utf8" });
  return result.status === 0;
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

function sharedReviewActivityIndex(repository, checkout, mainRevision) {
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
      const acceptedCommit = review.accepted?.accepted
        ? safeRevision(review.accepted.commit, "accepted commit")
        : "";
      const accepted = acceptedCommit ? {
        accepted: true,
        acceptedAt: review.acceptedAt || null,
        commit: acceptedCommit,
        delivery: review.accepted.delivery === "main" ? "main" : "pull-request",
        acceptanceBranch: review.accepted.acceptanceBranch
          ? safeBranchName(review.accepted.acceptanceBranch, "acceptance branch")
          : "",
        pullRequestUrl: String(review.accepted.pullRequestUrl || ""),
        merged: review.accepted.delivery === "main" || gitIsAncestor(checkout, acceptedCommit, mainRevision),
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

function sharedMainAcceptanceIndex(synced, checkout) {
  const index = new Map();
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
        merged: true,
        proposalHead: item.acceptance.proposalHead,
        sessionId: item.acceptance.sessionId,
      };
      if (!index.has(item.acceptance.proposal)) index.set(item.acceptance.proposal, accepted);
    } catch {}
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
  return [...sharedMainAcceptanceIndex(synced, main.checkout).entries()].map(([proposal, accepted]) => ({ proposal, ...accepted }));
}

function ownerProposalDecisionIndex(repository) {
  const inspected = inspectOwnerProposalDecisions(repository, proposalDecisionAuthorityOptions());
  const decisions = new Map();
  if (inspected.integrity === "verified") {
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
  return {
    expectedArchive,
    archiveHead,
    decision,
    verified: archiveHead === proposalHead,
  };
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
  const observations = readProposalObservations(repository);
  const visible = [];
  const currentBranches = new Set();

  for (const item of current) {
    currentBranches.add(item.branch);
    const rejection = proposalRejectionEvidence(synced, checkout, item.branch, item.head, decisionIndex);
    observations.proposals[item.branch] = observedProposalValue(item, rejection.verified ? "rejected" : "active");
    if (rejection.verified) continue;
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
}

function listRemoteSharedProposals(synced, { allProjects = true } = {}) {
  const checkout = repositoryCheckout(synced.connection.repository);
  const reviewActivity = sharedReviewActivityIndex(synced.connection.repository, checkout, synced.revision);
  const remoteAcceptance = sharedRemoteAcceptanceIndex(synced, checkout);
  const mainAcceptance = sharedMainAcceptanceIndex(synced, checkout);
  const prefix = `refs/remotes/origin/${synced.repositoryConfig.proposalPrefix}`;
  const decisionIndex = ownerProposalDecisionIndex(synced.connection.repository);
  const output = tryGit(checkout, ["for-each-ref", "--format=%(refname:strip=3)%09%(objectname)%09%(committerdate:iso8601)%09%(authorname)%09%(authoremail)%09%(subject)", prefix]);
  const current = output.split("\n").filter(Boolean).flatMap((line) => {
    const [branch, head, updatedAt, authorName, authorEmail, subject] = line.split("\t");
    try {
      const proposalHead = safeRevision(head, "proposal head");
      const identity = proposalIdentity(synced.repositoryConfig, branch, { checkout, revision: proposalHead, catalog: synced.catalog });
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
      const files = gitChangedPaths(checkout, `${synced.revision}...${proposalHead}`);
      const activities = reviewActivity.get(branch) || [];
      const currentActivity = activities.find((activity) => activity.proposalHead === proposalHead) || null;
      const latestActivity = activities[0] || null;
      const durableAccepted = mainAcceptance.get(branch) || remoteAcceptance.get(branch);
      const accepted = currentActivity?.accepted || (durableAccepted?.proposalHead === proposalHead ? durableAccepted : null);
      const reviewStatus = accepted?.merged
        ? "merged"
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
      return [{
        ...identity,
        repository: synced.connection.repository,
        repositoryName: synced.repositoryConfig.name,
        projectTitle: synced.catalog.projects.find((project) => project.id === identity.projectId)?.title || (identity.projectId === "global" ? "Global skills" : identity.projectId === "skills" ? "Shared skill locations" : identity.projectId),
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
      }];
    } catch {
      return [];
    }
  });
  return reconcileProposalObservations(synced, checkout, current, mainAcceptance, remoteAcceptance, decisionIndex)
    .filter((item) => allProjects || item.projectId === synced.connection.projectId || item.projectId === "global" || item.projectId === "skills")
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

export function materializeSharedReview(root, { proposal, expectedHead = "" } = {}) {
  const synced = syncSharedContext(root, { allowOffline: false });
  return materializeSharedReviewFromState(synced, { proposal, expectedHead });
}

export function materializeSharedRepositoryReview(repository, { proposal, expectedHead = "" } = {}) {
  const synced = syncSharedRepositoryState(repository, { allowOffline: false });
  return materializeSharedReviewFromState(synced, { proposal, expectedHead });
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
      const review = readSharedReview(reviewRoot);
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
  const match = listRemoteSharedProposals(synced).find((item) => item.branch === proposal);
  if (!match) throw new Error(`Remote proposal not found: ${proposal}`);
  if (expectedHead && match.head !== safeRevision(expectedHead, "expected proposal head")) {
    throw new Error("Proposal changed before review; refresh and open its current exact revision");
  }
  const reusable = reusableSharedReview(synced, match);
  if (reusable) return reusable;
  const checkout = repositoryCheckout(synced.connection.repository);
  const changedFiles = gitChangedPaths(checkout, `${synced.revision}...${match.head}`);
  const proposalChanges = gitNameStatusChanges(checkout, synced.revision, match.head).map((change) => ({
    path: change.path,
    status: change.status,
    fromPath: change.fromPath || null,
    score: change.score || null,
    reviewKind: "proposal-change",
  }));
  if (!changedFiles.length) throw new Error("Proposal has no changes relative to shared main");
  assertPathsInProposalScope(changedFiles, match);
  const scopePaths = [...(match.allowedExact || []), ...match.allowedPrefixes];
  assertSafeTreeEntries(checkout, synced.revision, scopePaths);
  assertSafeTreeEntries(checkout, match.head, scopePaths);
  assertReviewableChangedPaths(checkout, synced.revision, match.head, changedFiles);
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

export function readSharedReview(root) {
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
      const checkout = ensureRepositoryClone(metadata.repository);
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
    if (!fs.existsSync(absolute)) continue;
    const stats = fs.lstatSync(absolute);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Shared reviews reject symlinks and special files: ${filePath}`);
    const real = fs.realpathSync(absolute);
    if (real !== stableReviewRoot && !real.startsWith(stableReviewRoot + path.sep)) throw new Error(`Shared review path escapes its worktree: ${filePath}`);
    const content = fs.readFileSync(absolute);
    if (content.length > MAX_SHARED_TEXT_BYTES) throw new Error(`Shared review file is too large: ${filePath}`);
    if (!isUtf8(content) || content.includes(0)) throw new Error(`Shared reviews only support UTF-8 text files: ${filePath}`);
  }
}

function assertSharedInstructionMappingsPresent(root, repositoryConfig, catalog) {
  const manifest = path.join(root, repositoryConfig.instructionLocationsFile);
  if (!fs.existsSync(manifest)) return;
  const locations = normalizedSharedInstructionLocations(readJson(manifest), { repositoryConfig, catalog });
  const collections = new Map(locations.collections.map((collection) => [collection.id, collection]));
  for (const assignment of locations.assignments) {
    const collection = collections.get(assignment.collectionId);
    for (const mapping of assignment.files) {
      const source = path.join(root, collection.path, ...mapping.source.split("/"));
      if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) {
        throw new Error(`Instruction assignment ${assignment.id} references a missing accepted file: ${collection.path}/${mapping.source}`);
      }
    }
  }
}

function addIntentToAdd(root, files) {
  for (let index = 0; index < files.length; index += 200) {
    runGit(root, ["add", "-N", "--", ...files.slice(index, index + 200)]);
  }
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

function assertExactSharedFileReviews(reviewRoot, proposalFiles, reviewState) {
  const missing = [];
  for (const filePath of proposalFiles) {
    const abs = path.join(reviewRoot, ...filePath.split("/"));
    const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
    const contentHash = createHash("sha256").update(exists ? fs.readFileSync(abs) : Buffer.alloc(0)).digest("hex");
    const review = reviewState.reviews?.[filePath];
    const resourceState = exists ? "present" : "absent";
    const stateMatches = review?.resourceState
      ? review.resourceState === resourceState
      : resourceState === "present";
    if (review?.status !== "verified" || review.contentHash !== contentHash || !stateMatches || (resourceState === "absent" && !review.resourceVersion)) {
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
      if (item?.status !== "verified" || !item.contentHash) return [];
      const blob = tryGit(review.reviewRoot, ["hash-object", "--", filePath]);
      return [{ path: filePath, blob, contentHash: item.contentHash, dependencies: item.dependencyVersions || {} }];
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

export function acceptSharedReview(reviewRoot, { message = "Accept shared context proposal", actor = null, push = null } = {}) {
  const resolvedReviewRoot = path.resolve(reviewRoot);
  const review = readSharedReview(resolvedReviewRoot);
  if (review.accepted) throw new Error("This exact shared review was already accepted and cannot be reused");
  const checkout = ensureRepositoryClone(review.repository);
  runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
  const reviewHead = safeRevision(tryGit(resolvedReviewRoot, ["rev-parse", "HEAD"]), "review worktree head");
  if (reviewHead !== review.baseRevision) throw new Error("Review worktree history changed; materialize the proposal again");
  const configText = runGit(checkout, ["show", `${review.baseRevision}:${SHARED_REPOSITORY_CONFIG}`]);
  const repositoryConfig = normalizedRepositoryConfig(JSON.parse(configText));
  const catalog = normalizedProjectsCatalog(JSON.parse(String(runGit(checkout, ["show", `${review.baseRevision}:${repositoryConfig.projectsFile}`]))));
  const policy = proposalIdentity(repositoryConfig, review.proposal, { checkout, revision: review.proposalHead, catalog });
  if (policy.projectId !== review.projectId || policy.scope !== review.scope) throw new Error("Shared review scope metadata is invalid");
  const currentProposalHead = remoteRevision(checkout, review.proposal);
  if (currentProposalHead !== review.proposalHead) throw new Error("Proposal changed after review; materialize and review the new exact commit");
  const proposalFiles = gitChangedPaths(checkout, `${review.baseRevision}...${review.proposalHead}`);
  assertPathsInProposalScope(proposalFiles, policy);
  assertReviewableChangedPaths(checkout, review.baseRevision, review.proposalHead, proposalFiles);
  const requiredReviewFiles = [...new Set([...(review.proposalFiles || []), ...proposalFiles])];
  if (proposalFiles.some((filePath) => !(review.proposalFiles || []).includes(filePath))) {
    throw new Error("Shared review authority does not include every proposal-changed file");
  }
  const reviewState = trustedSharedReviewState(resolvedReviewRoot);
  assertExactSharedFileReviews(resolvedReviewRoot, requiredReviewFiles, reviewState);
  const currentMain = remoteRevision(checkout, review.defaultBranch);
  const workspace = reviewWorkspaceChanges(resolvedReviewRoot, review.baseRevision);
  assertPathsInProposalScope(workspace.files, policy);
  assertReviewWorkspaceFiles(resolvedReviewRoot, workspace.files);
  addIntentToAdd(resolvedReviewRoot, workspace.untracked);
  const policyPaths = [...(policy.allowedExact || []), ...policy.allowedPrefixes];
  const acceptedPatch = runGit(resolvedReviewRoot, ["diff", "--binary", "--full-index", review.baseRevision, "--", ...policyPaths], { encoding: null });
  if (!acceptedPatch.length) return { accepted: false, reason: "No accepted changes remain", proposal: review.proposal };
  const acceptanceRoot = path.join(repositoryCacheRoot(review.repository), "accept", `${hashKey(review.proposal)}-${Date.now()}`);
  runGit(checkout, ["worktree", "add", "--detach", acceptanceRoot, currentMain], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const applied = spawnSync("git", ["apply", "--3way", "--whitespace=nowarn", "-"], { cwd: acceptanceRoot, input: acceptedPatch, encoding: "utf8" });
    if (applied.status !== 0 || tryGit(acceptanceRoot, ["diff", "--name-only", "--diff-filter=U"])) {
      throw new Error("Accepted result conflicts with the current main branch; review the resolved result again");
    }
    assertSharedInstructionMappingsPresent(acceptanceRoot, repositoryConfig, catalog);
    runGit(acceptanceRoot, ["add", "-A", "--", ...policyPaths]);
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
    assertSafeTreeEntries(acceptanceRoot, acceptedCommit, policy.allowedPrefixes);
    assertReviewableChangedPaths(acceptanceRoot, currentMain, acceptedCommit, workspace.files);
    if (push?.token && push?.url) {
      runGit(acceptanceRoot, ["push", String(push.url), `HEAD:refs/heads/${review.defaultBranch}`], {
        stdio: ["ignore", "ignore", "pipe"],
        env: gitHubAppGitEnvironment(push.token),
      });
    } else {
      runGit(acceptanceRoot, ["push", "origin", `HEAD:refs/heads/${review.defaultBranch}`], { stdio: ["ignore", "ignore", "pipe"] });
    }
    const result = {
      accepted: true,
      delivery: "main",
      proposal: review.proposal,
      proposalHead: review.proposalHead,
      previousMain: currentMain,
      commit: acceptedCommit,
      defaultBranch: review.defaultBranch,
      actor: actor ? { sub: auditTrailerValue(actor.sub, "reviewer identity"), email: auditTrailerValue(actor.email, "reviewer email") } : null,
    };
    writeJson(path.join(sharedHome(), "review-authority", `${review.authorityId}.json`), { ...review, accepted: result, acceptedAt: new Date().toISOString() });
    appendContextRoomEvent("proposal.completed", {
      projectId: review.projectId,
      sharedRepository: review.repository,
      resource: { proposal: review.proposal, proposalHead: review.proposalHead },
      actor: actor ? { sub: auditTrailerValue(actor.sub, "reviewer identity"), email: auditTrailerValue(actor.email, "reviewer email") } : null,
      data: { commit: acceptedCommit, previousMain: currentMain, defaultBranch: review.defaultBranch },
    });
    return result;
  } finally {
    try { runGit(checkout, ["worktree", "remove", "--force", acceptanceRoot], { stdio: ["ignore", "ignore", "ignore"] }); } catch {}
  }
}
