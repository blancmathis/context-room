import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { withFilesystemLock } from "./filesystem_lock.mjs";

export const MAX_CONTEXT_TEXT_BYTES = 750_000;
export const AGENT_CONTEXT_OPERATIONS = Object.freeze([
  "capabilities:read",
  "accepted:read",
  "proposal:list",
  "proposal:write",
  "proposal:checkout",
  "proposal:publish",
  "ui:workspace:list",
  "ui:workspace:navigate",
  "ui:workspace:pair",
]);

function gatewayError(message, statusCode, code, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function safeProjectId(value) {
  const projectId = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) throw gatewayError("The Context Room project id is invalid.", 400, "agent_project_invalid");
  return projectId;
}

export function assertAgentOperation(identity, operation, requestedProjectId) {
  if (identity?.kind !== "agent") throw gatewayError("An agent capability is required.", 403, "agent_identity_required");
  const projectId = safeProjectId(identity.projectId);
  if (projectId !== safeProjectId(requestedProjectId)) throw gatewayError("The agent capability belongs to another Context Room project.", 403, "agent_project_scope_denied");
  if (!AGENT_CONTEXT_OPERATIONS.includes(operation) || !Array.isArray(identity.operations) || !identity.operations.includes(operation)) {
    throw gatewayError("The agent capability does not allow this operation.", 403, "agent_operation_denied");
  }
  return { ...identity, projectId };
}

export function assertContextProjectPath(projectId, input) {
  const normalizedProjectId = safeProjectId(projectId);
  const raw = String(input || "").replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || raw.includes("\0") || raw.split("/").includes("..")) throw gatewayError("The requested path is outside the agent project.", 403, "agent_path_denied");
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  const prefixes = [
    `projects/${normalizedProjectId}/docs/`,
    `projects/${normalizedProjectId}/skills/`,
  ];
  if (!prefixes.some((prefix) => normalized.startsWith(prefix)) || normalized.endsWith("/")) throw gatewayError("The requested path is outside project docs and skills.", 403, "agent_path_denied");
  return normalized;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertExpectedHash(value, field, length) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(normalized)) throw gatewayError(`${field} is required.`, 400, "agent_revision_required");
  return normalized;
}

export function validateTextPatch(input, { projectId }) {
  const filePath = assertContextProjectPath(projectId, input?.path);
  const content = String(input?.content ?? "");
  if (content.includes("\0")) throw gatewayError("Binary content is not accepted.", 400, "agent_binary_denied");
  if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_TEXT_BYTES) throw gatewayError("Context files cannot exceed 750 KB.", 413, "agent_file_too_large");
  if (String(input?.entryType || "file") !== "file") throw gatewayError("Symlinks and gitlinks are not accepted.", 400, "agent_entry_type_denied");
  return {
    path: filePath,
    content,
    expectedContentHash: assertExpectedHash(input?.expectedContentHash, "expectedContentHash", 64),
    expectedProposalHead: assertExpectedHash(input?.expectedProposalHead, "expectedProposalHead", 40),
    entryType: "file",
  };
}

function git(cwd, args, options = {}) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })).trim();
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function filesystemIdentity(stats) {
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
}

const ANCHORED_AGENT_PATCH_SCRIPT = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");

function statsOf(stats) {
  return {
    type: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other",
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    nlink: Number(stats.nlink),
    size: Number(stats.size),
    mode: Number(stats.mode & 0o777n),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
}

function fail(code, message, details) {
  const error = new Error(message || code);
  error.code = code;
  error.details = details;
  throw error;
}

function sameIdentity(actual, expected) {
  return actual.dev === String(expected.dev) && actual.ino === String(expected.ino);
}

function assertSingleLinkRegularFile(stats) {
  if (stats.type !== "file") fail("AGENT_ENTRY_TYPE_DENIED", "Only regular text files can be changed");
  if (stats.nlink !== 1) fail("AGENT_ENTRY_TYPE_DENIED", "Hard-linked proposal files cannot be changed");
  return stats;
}

function safeName(value) {
  const name = String(value || "");
  if (!name || name === "." || name === ".." || name !== require("node:path").basename(name)) fail("EINVAL", "Unsafe proposal entry name");
  return name;
}

function assertAnchoredParent(request) {
  const cwd = statsOf(fs.statSync(".", { bigint: true }));
  if (cwd.type !== "directory" || !sameIdentity(cwd, request.parent)) fail("ESTALE", "Proposal parent changed");
  const visible = statsOf(fs.lstatSync(request.parentPath, { bigint: true }));
  if (visible.type !== "directory" || !sameIdentity(visible, request.parent)) fail("ESTALE", "Proposal parent is no longer visible");
}

function visibleEntry(name, expected) {
  const visible = statsOf(fs.lstatSync(name, { bigint: true }));
  if (visible.type !== expected.type || !sameIdentity(visible, expected)) fail("ESTALE", "Proposal entry changed");
  return visible;
}

function readStableFile(fd, maximumBytes) {
  const before = statsOf(fs.fstatSync(fd, { bigint: true }));
  assertSingleLinkRegularFile(before);
  if (before.size > maximumBytes) fail("AGENT_FILE_TOO_LARGE", "Context file exceeds its size limit");
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  const extra = Buffer.allocUnsafe(1);
  const grew = fs.readSync(fd, extra, 0, 1, offset) > 0;
  const after = statsOf(fs.fstatSync(fd, { bigint: true }));
  assertSingleLinkRegularFile(after);
  if (grew || offset !== before.size || JSON.stringify(before) !== JSON.stringify(after)) fail("ESTALE", "Proposal entry changed while being read");
  return { bytes, stats: after, contentHash: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function removeCreatedEntry(name, created) {
  try {
    const visible = statsOf(fs.lstatSync(name, { bigint: true }));
    if (visible.type === "file" && sameIdentity(visible, created)) fs.unlinkSync(name);
  } catch {}
}

function writeAtomicReplacement(name, bytes, mode) {
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  const temporary = ".context-room-agent-patch-" + process.pid + "-" + crypto.randomUUID() + ".tmp";
  let fd = null;
  let created = null;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      Number(mode || 0o644),
    );
    created = statsOf(fs.fstatSync(fd, { bigint: true }));
    assertSingleLinkRegularFile(created);
    fs.fchmodSync(fd, Number(mode || 0o644));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail("EIO", "Unable to complete proposal write");
      offset += count;
    }
    fs.fsyncSync(fd);
    const written = readStableFile(fd, Number(bytes.length));
    const expectedHash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (written.contentHash !== expectedHash) fail("EIO", "Proposal write verification failed");
    return { temporary, created, written };
  } catch (error) {
    if (created) removeCreatedEntry(temporary, created);
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function createDirectory(request) {
  const name = safeName(request.name);
  assertAnchoredParent(request);
  fs.mkdirSync(name, { mode: 0o755 });
  const created = statsOf(fs.lstatSync(name, { bigint: true }));
  if (created.type !== "directory") fail("ESTALE", "Created proposal parent is not a directory");
  assertAnchoredParent(request);
  visibleEntry(name, created);
  return created;
}

function preflightPatch(request) {
  const name = safeName(request.name);
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  let fd = null;
  assertAnchoredParent(request);
  let visibleBefore = null;
  try {
    visibleBefore = statsOf(fs.lstatSync(name, { bigint: true }));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!visibleBefore) {
    assertAnchoredParent(request);
    if (request.expectedContentHash === request.emptyContentHash) {
      return { contentHash: request.emptyContentHash, missing: true };
    }
    fail("AGENT_FILE_STALE", "Proposal file is missing", { currentContentHash: request.emptyContentHash });
  }
  assertSingleLinkRegularFile(visibleBefore);
  try {
    try {
      fd = fs.openSync(name, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
      if (error.code === "ENOENT") {
        fail("AGENT_FILE_STALE", "Proposal file disappeared before it could be read", { currentContentHash: request.emptyContentHash });
      }
      throw error;
    }
    const opened = statsOf(fs.fstatSync(fd, { bigint: true }));
    assertSingleLinkRegularFile(opened);
    if (!sameIdentity(opened, visibleBefore)) fail("ESTALE", "Proposal entry changed before open");
    visibleEntry(name, opened);
    assertAnchoredParent(request);
    const current = readStableFile(fd, Number(request.maximumBytes));
    if (JSON.stringify(opened) !== JSON.stringify(current.stats)) fail("ESTALE", "Proposal entry changed before read");
    visibleEntry(name, current.stats);
    assertAnchoredParent(request);
    if (current.contentHash !== request.expectedContentHash) {
      fail("AGENT_FILE_STALE", "Proposal file content changed", { currentContentHash: current.contentHash });
    }
    return { contentHash: current.contentHash, missing: false };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function applyPatch(request) {
  const name = safeName(request.name);
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  let fd = null;
  let replacement = null;
  try {
    assertAnchoredParent(request);
    let visibleBefore = null;
    try {
      visibleBefore = statsOf(fs.lstatSync(name, { bigint: true }));
      assertSingleLinkRegularFile(visibleBefore);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let current = null;
    if (visibleBefore) {
      try {
        fd = fs.openSync(name, fs.constants.O_RDONLY | noFollow);
      } catch (error) {
        if (error.code === "ENOENT") {
          fail("AGENT_FILE_STALE", "Proposal file disappeared before it could be read", { currentContentHash: request.emptyContentHash });
        }
        throw error;
      }
      const opened = statsOf(fs.fstatSync(fd, { bigint: true }));
      assertSingleLinkRegularFile(opened);
      if (!sameIdentity(opened, visibleBefore)) fail("ESTALE", "Proposal entry changed before open");
      visibleEntry(name, opened);
      assertAnchoredParent(request);
      current = readStableFile(fd, Number(request.maximumBytes));
      if (JSON.stringify(opened) !== JSON.stringify(current.stats)) fail("ESTALE", "Proposal entry changed before read");
      visibleEntry(name, current.stats);
      assertAnchoredParent(request);
      if (current.contentHash !== request.expectedContentHash) {
        fail("AGENT_FILE_STALE", "Proposal file content changed", { currentContentHash: current.contentHash });
      }
    } else {
      if (request.expectedContentHash !== request.emptyContentHash) {
        fail("AGENT_FILE_STALE", "Proposal file is missing", { currentContentHash: request.emptyContentHash });
      }
      assertAnchoredParent(request);
    }
    const bytes = Buffer.from(String(request.content || ""), "utf8");
    replacement = writeAtomicReplacement(name, bytes, current?.stats.mode || 0o644);
    if (visibleBefore) {
      const visibleNow = statsOf(fs.lstatSync(name, { bigint: true }));
      if (JSON.stringify(visibleNow) !== JSON.stringify(current.stats)) fail("ESTALE", "Proposal entry changed before replacement");
      assertAnchoredParent(request);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(replacement.temporary, name);
    } else {
      assertAnchoredParent(request);
      try {
        fs.linkSync(replacement.temporary, name);
      } catch (error) {
        if (error.code === "EEXIST") fail("AGENT_FILE_STALE", "Proposal file appeared before it could be created");
        throw error;
      }
      fs.unlinkSync(replacement.temporary);
    }
    const installed = statsOf(fs.lstatSync(name, { bigint: true }));
    assertSingleLinkRegularFile(installed);
    if (!sameIdentity(installed, replacement.written.stats)) fail("EIO", "Proposal replacement identity changed during install");
    assertAnchoredParent(request);
    const contentHash = replacement.written.contentHash;
    replacement = null;
    return { contentHash };
  } catch (error) {
    if (replacement?.created) removeCreatedEntry(replacement.temporary, replacement.created);
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

try {
  const request = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  process.chdir(String(request.parentPath || ""));
  const result = request.operation === "mkdir"
    ? createDirectory(request)
    : request.operation === "preflight"
      ? preflightPatch(request)
      : applyPatch(request);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    code: error && error.code || "EIO",
    message: error && error.message || String(error),
    details: error && error.details || null,
  }));
}
`;

function runAnchoredProposalOperation(parentPath, parentStats, operation) {
  let output;
  try {
    output = execFileSync(process.execPath, ["-e", ANCHORED_AGENT_PATCH_SCRIPT], {
      cwd: path.parse(path.resolve(parentPath)).root,
      input: JSON.stringify({ parentPath, parent: filesystemIdentity(parentStats), ...operation }),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw gatewayError("The proposal path could not be anchored safely.", 403, "agent_path_denied", { cause: error.code || "agent_anchor_failed" });
  }
  let result;
  try {
    result = JSON.parse(output || "{}");
  } catch {
    throw gatewayError("The proposal path could not be anchored safely.", 403, "agent_path_denied");
  }
  if (result.ok) return result.result;
  if (result.code === "AGENT_FILE_STALE") {
    throw gatewayError("The file changed; reload it before editing.", 409, "agent_file_stale", result.details || undefined);
  }
  if (result.code === "AGENT_FILE_TOO_LARGE") throw gatewayError("Context files cannot exceed 750 KB.", 413, "agent_file_too_large");
  if (result.code === "AGENT_ENTRY_TYPE_DENIED") throw gatewayError("Only regular text files can be changed.", 400, "agent_entry_type_denied");
  if (["EACCES", "EEXIST", "ELOOP", "ENOENT", "ENOTDIR", "EPERM", "ESTALE", "EINVAL"].includes(result.code)) {
    throw gatewayError("The requested path escapes the proposal checkout.", 403, "agent_path_denied");
  }
  const error = new Error(result.message || "Unable to apply the proposal patch");
  error.code = result.code || "agent_patch_failed";
  throw error;
}

function inspectProposalDirectory(root, directoryPath) {
  let stats;
  try {
    stats = fs.lstatSync(directoryPath, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw gatewayError("The proposal path could not be inspected safely.", 403, "agent_path_denied");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw gatewayError("The proposal path contains an unsafe parent.", 403, "agent_path_denied");
  let physical;
  try {
    physical = fs.realpathSync(directoryPath);
  } catch {
    throw gatewayError("The proposal path could not be resolved safely.", 403, "agent_path_denied");
  }
  if (path.resolve(physical) !== path.resolve(directoryPath) || !pathIsWithin(root, physical)) {
    throw gatewayError("The proposal path leaves its physical checkout.", 403, "agent_path_denied");
  }
  return stats;
}

function proposalTrustAnchor(requestedRoot) {
  const configuredSharedHome = String(process.env.CONTEXT_ROOM_SHARED_HOME || "").trim();
  const candidates = [
    configuredSharedHome,
    os.tmpdir(),
    process.env.HOME,
    os.homedir(),
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
  const anchor = [...new Set(candidates)]
    .filter((candidate) => pathIsWithin(candidate, requestedRoot))
    .sort((left, right) => right.length - left.length)[0];
  if (!anchor) throw gatewayError("The proposal checkout has no trusted filesystem anchor.", 403, "agent_path_denied");
  let physicalAnchor;
  try {
    physicalAnchor = fs.realpathSync(anchor);
  } catch {
    throw gatewayError("The proposal filesystem anchor is unavailable.", 403, "agent_path_denied");
  }
  const relative = path.relative(anchor, requestedRoot);
  return { physicalAnchor, expectedPhysicalRoot: path.resolve(physicalAnchor, relative) };
}

function secureProposalRoot(root, branch = "") {
  const requestedRoot = path.resolve(root);
  let requestedRootStats;
  try {
    requestedRootStats = fs.lstatSync(requestedRoot, { bigint: true });
  } catch {
    throw gatewayError("The proposal checkout is unavailable.", 403, "agent_path_denied");
  }
  if (requestedRootStats.isSymbolicLink() || !requestedRootStats.isDirectory()) {
    throw gatewayError("The proposal checkout must be a physical directory.", 403, "agent_path_denied");
  }
  const { physicalAnchor, expectedPhysicalRoot } = proposalTrustAnchor(requestedRoot);
  const physicalRoot = fs.realpathSync(requestedRoot);
  if (path.resolve(physicalRoot) !== expectedPhysicalRoot) {
    throw gatewayError("The proposal checkout crosses a symbolic filesystem boundary.", 403, "agent_path_denied");
  }
  let current = physicalAnchor;
  let physicalRootStats = inspectProposalDirectory(physicalAnchor, physicalAnchor);
  const relativeSegments = path.relative(physicalAnchor, physicalRoot).split(path.sep).filter(Boolean);
  for (const segment of relativeSegments) {
    current = path.join(current, segment);
    physicalRootStats = inspectProposalDirectory(physicalAnchor, current);
    if (!physicalRootStats) throw gatewayError("The proposal checkout is incomplete.", 403, "agent_path_denied");
  }
  if (!(
    requestedRootStats.dev.toString() === physicalRootStats.dev.toString()
    && requestedRootStats.ino.toString() === physicalRootStats.ino.toString()
  )) {
    throw gatewayError("The proposal checkout changed while it was resolved.", 403, "agent_path_denied");
  }
  if (branch) {
    const expectedName = sha256(String(branch)).slice(0, 16);
    if (path.basename(physicalRoot) !== expectedName || path.basename(path.dirname(physicalRoot)) !== "proposals") {
      throw gatewayError("The proposal checkout does not match its deterministic workspace.", 403, "agent_path_denied");
    }
  }
  return { physicalRoot, rootStats: physicalRootStats };
}

function secureProposalParent(physicalRoot, rootStats, filePath, { allowCreate = true, expectedContentHash = "", emptyContentHash = "" } = {}) {
  const segments = filePath.split("/");
  const fileName = segments.pop();
  let current = physicalRoot;
  let currentStats = rootStats;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    let candidateStats = inspectProposalDirectory(physicalRoot, candidate);
    if (!candidateStats) {
      if (!allowCreate) {
        throw gatewayError("The file changed; reload it before editing.", 409, "agent_file_stale", {
          path: filePath,
          expectedContentHash,
          currentContentHash: emptyContentHash,
        });
      }
      try {
        runAnchoredProposalOperation(current, currentStats, { operation: "mkdir", name: segment });
      } catch (error) {
        if (error.code !== "agent_path_denied") throw error;
        candidateStats = inspectProposalDirectory(physicalRoot, candidate);
        if (!candidateStats) throw error;
      }
      candidateStats = inspectProposalDirectory(physicalRoot, candidate);
    }
    current = candidate;
    currentStats = candidateStats;
  }
  return { physicalRoot, parentPath: current, parentStats: currentStats, fileName };
}

function applyTextPatchUnderLock(proposal, patch, physicalRoot) {
  const currentRoot = secureProposalRoot(proposal.root, proposal.branch);
  if (currentRoot.physicalRoot !== physicalRoot) throw gatewayError("The proposal checkout changed before editing.", 403, "agent_path_denied");
  const { rootStats } = currentRoot;
  const actualHead = git(physicalRoot, ["rev-parse", "HEAD"]);
  if (actualHead !== patch.expectedProposalHead) throw gatewayError("The proposal changed; reload its exact revision before editing.", 409, "agent_proposal_stale", { expectedProposalHead: patch.expectedProposalHead, currentProposalHead: actualHead });
  const mode = git(physicalRoot, ["ls-files", "-s", "--", patch.path]).split(/\s+/)[0] || "";
  if (mode && mode !== "100644" && mode !== "100755") throw gatewayError("Gitlinks and special Git entries are not accepted.", 400, "agent_entry_type_denied");
  const emptyContentHash = sha256(Buffer.alloc(0));
  const { parentPath, parentStats, fileName } = secureProposalParent(physicalRoot, rootStats, patch.path, {
    allowCreate: patch.expectedContentHash === emptyContentHash,
    expectedContentHash: patch.expectedContentHash,
    emptyContentHash,
  });
  let changed;
  try {
    changed = runAnchoredProposalOperation(parentPath, parentStats, {
      operation: "patch",
      name: fileName,
      content: patch.content,
      expectedContentHash: patch.expectedContentHash,
      emptyContentHash,
      maximumBytes: MAX_CONTEXT_TEXT_BYTES,
    });
  } catch (error) {
    if (error.code === "agent_file_stale") {
      error.details = {
        path: patch.path,
        expectedContentHash: patch.expectedContentHash,
        currentContentHash: error.details?.currentContentHash || "",
      };
    }
    throw error;
  }
  return { path: patch.path, contentHash: changed.contentHash, proposalHead: actualHead };
}

export function preflightTextPatch(proposal, input, { projectId }) {
  const patch = validateTextPatch(input, { projectId });
  const { physicalRoot, rootStats } = secureProposalRoot(proposal.root, proposal.branch);
  const actualHead = git(physicalRoot, ["rev-parse", "HEAD"]);
  if (actualHead !== patch.expectedProposalHead) {
    throw gatewayError("The proposal changed; reload its exact revision before editing.", 409, "agent_proposal_stale", {
      expectedProposalHead: patch.expectedProposalHead,
      currentProposalHead: actualHead,
    });
  }
  const mode = git(physicalRoot, ["ls-files", "-s", "--", patch.path]).split(/\s+/)[0] || "";
  if (mode && mode !== "100644" && mode !== "100755") {
    throw gatewayError("Gitlinks and special Git entries are not accepted.", 400, "agent_entry_type_denied");
  }
  const emptyContentHash = sha256(Buffer.alloc(0));
  const segments = patch.path.split("/");
  const fileName = segments.pop();
  let current = physicalRoot;
  let currentStats = rootStats;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    const candidateStats = inspectProposalDirectory(physicalRoot, candidate);
    if (!candidateStats) {
      if (patch.expectedContentHash === emptyContentHash) return patch;
      throw gatewayError("The file changed; reload it before editing.", 409, "agent_file_stale", {
        path: patch.path,
        expectedContentHash: patch.expectedContentHash,
        currentContentHash: emptyContentHash,
      });
    }
    current = candidate;
    currentStats = candidateStats;
  }
  try {
    runAnchoredProposalOperation(current, currentStats, {
      operation: "preflight",
      name: fileName,
      expectedContentHash: patch.expectedContentHash,
      emptyContentHash,
      maximumBytes: MAX_CONTEXT_TEXT_BYTES,
    });
  } catch (error) {
    if (error.code === "agent_file_stale") {
      error.details = {
        path: patch.path,
        expectedContentHash: patch.expectedContentHash,
        currentContentHash: error.details?.currentContentHash || "",
      };
    }
    throw error;
  }
  return patch;
}

export function applyTextPatch(proposal, input, { projectId, lockTimeoutMs = 5_000 }) {
  const patch = validateTextPatch(input, { projectId });
  const { physicalRoot } = secureProposalRoot(proposal.root, proposal.branch);
  const proposalCacheRoot = proposal.branch ? path.dirname(path.dirname(physicalRoot)) : "";
  const lockPath = proposalCacheRoot
    ? path.join(proposalCacheRoot, "proposals.json.lock")
    : path.join(os.tmpdir(), `.context-room-agent-patch-${sha256(physicalRoot).slice(0, 24)}.lock`);
  return withFilesystemLock(lockPath, () => applyTextPatchUnderLock(proposal, patch, physicalRoot), {
    timeoutMs: Math.max(1, Math.min(5_000, Number(lockTimeoutMs) || 5_000)),
    busyMessage: "The proposal is busy; retry the patch.",
    busyCode: "agent_patch_busy",
  });
}

export function projectDocuments(documents, projectId) {
  const normalizedProjectId = safeProjectId(projectId);
  return documents.filter((item) => {
    try {
      assertContextProjectPath(normalizedProjectId, item.path);
      return true;
    } catch {
      return false;
    }
  }).map((item) => ({ ...item, contentHash: sha256(Buffer.from(item.content, "utf8")) }));
}
