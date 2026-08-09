import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFilesystemLock } from "./filesystem_lock.mjs";

const REVIEW_AUTHORITY_VERSION = 1;
const LIVE_MODES = new Set(["recursive-live", "direct-live"]);
const CURRENT_MODES = new Set(["recursive-current", "direct-current"]);
const TERMINAL_DECISION_CHALLENGE_FIELDS = Object.freeze([
  "principal",
  "authorityId",
  "proposal",
  "proposalHead",
  "action",
]);
const DEFAULT_TERMINAL_DECISION_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_VERIFIED_ACCEPTANCE_FLASH_TTL_MS = 2 * 60 * 1000;
const VERIFIED_ACCEPTANCE_FLASH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const PROPOSAL_DECISION_LOCK_TIMEOUT_MS = 5_000;
const PROPOSAL_DECISION_LOCK_STALE_MS = 250;
const SIGNED_STATE_TRANSACTION_VERSION = 1;
const SIGNED_STATE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_AUTHORITY_FILES = 256;
const MAX_LEGACY_AUTHORITY_DIRECTORY_ENTRIES = 65_536;
const MAX_LEGACY_AUTHORITY_SCAN_FILES = 32_768;
const MAX_LEGACY_AUTHORITY_SCAN_BYTES = 512 * 1024 * 1024;

export const HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY = Object.freeze({
  confirmationsRequired: 2,
  appliesTo: Object.freeze(["multi-file-batch", "proposal-terminal"]),
  singleFileDecision: "direct-human-ui",
  firstConfirmation: "Ask the user explicitly whether they want the exact multi-file batch or terminal proposal decision.",
  secondConfirmation: "After the first yes, restate the exact action, project, proposal or file scope, and effects, then ask again.",
  mutationRule: "Do nothing unless the user gives a second separate, unambiguous yes.",
  instruction: "Before a multi-file batch or terminal proposal decision, an agent must ask the user explicitly. After the first yes, it must restate the exact action, project, proposal or file scope, and effects, ask again, and do nothing without a second separate, unambiguous yes. Single-file decisions stay in the direct human UI and never become agent-facing commands.",
});

function terminalDecisionChallengeError(code, message, statusCode = 403) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeTerminalDecisionChallengeBinding(binding = {}) {
  const normalized = Object.fromEntries(TERMINAL_DECISION_CHALLENGE_FIELDS.map((field) => [
    field,
    String(binding?.[field] || "").trim(),
  ]));
  const missing = TERMINAL_DECISION_CHALLENGE_FIELDS.filter((field) => !normalized[field]);
  if (missing.length) {
    throw terminalDecisionChallengeError(
      "terminal_decision_challenge_binding_invalid",
      `Terminal decision challenge binding is missing: ${missing.join(", ")}`,
      400,
    );
  }
  return normalized;
}

export function createTerminalDecisionChallengeStore({
  now = Date.now,
  ttlMs = DEFAULT_TERMINAL_DECISION_CHALLENGE_TTL_MS,
} = {}) {
  if (typeof now !== "function") throw new TypeError("Terminal decision challenge clock must be a function");
  const normalizedTtlMs = Number(ttlMs);
  if (!Number.isFinite(normalizedTtlMs) || normalizedTtlMs <= 0) {
    throw new TypeError("Terminal decision challenge TTL must be a positive number");
  }

  const records = new Map();
  const retentionMs = Math.max(DEFAULT_TERMINAL_DECISION_CHALLENGE_TTL_MS, normalizedTtlMs * 2);
  const currentTime = () => {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError("Terminal decision challenge clock returned an invalid time");
    return value;
  };
  const prune = (timestamp) => {
    for (const [challengeId, record] of records) {
      const terminalAt = record.consumedAt ?? record.expiresAt;
      if (timestamp - terminalAt > retentionMs) records.delete(challengeId);
    }
  };

  return {
    issue(binding = {}) {
      const timestamp = currentTime();
      prune(timestamp);
      const normalized = normalizeTerminalDecisionChallengeBinding(binding);
      const challengeId = randomBytes(32).toString("base64url");
      const record = {
        ...normalized,
        issuedAt: timestamp,
        expiresAt: timestamp + normalizedTtlMs,
        consumedAt: null,
      };
      records.set(challengeId, record);
      return {
        challengeId,
        authorityId: record.authorityId,
        proposal: record.proposal,
        proposalHead: record.proposalHead,
        action: record.action,
        expiresAt: new Date(record.expiresAt).toISOString(),
      };
    },

    consume(challengeId, binding = {}) {
      const id = String(challengeId || "").trim();
      if (!id) {
        throw terminalDecisionChallengeError(
          "terminal_decision_challenge_required",
          "A terminal decision challenge is required",
        );
      }
      const timestamp = currentTime();
      prune(timestamp);
      const record = records.get(id);
      if (!record) {
        throw terminalDecisionChallengeError(
          "terminal_decision_challenge_invalid",
          "The terminal decision challenge is invalid",
        );
      }
      if (record.consumedAt != null) {
        throw terminalDecisionChallengeError(
          "terminal_decision_challenge_replayed",
          "The terminal decision challenge has already been used",
        );
      }
      if (timestamp >= record.expiresAt) {
        throw terminalDecisionChallengeError(
          "terminal_decision_challenge_expired",
          "The terminal decision challenge has expired",
        );
      }

      const normalized = normalizeTerminalDecisionChallengeBinding(binding);
      if (TERMINAL_DECISION_CHALLENGE_FIELDS.some((field) => normalized[field] !== record[field])) {
        throw terminalDecisionChallengeError(
          "terminal_decision_challenge_mismatch",
          "The terminal decision challenge does not match this exact action",
        );
      }

      record.consumedAt = timestamp;
      return {
        authorityId: record.authorityId,
        proposal: record.proposal,
        proposalHead: record.proposalHead,
        action: record.action,
        consumedAt: new Date(record.consumedAt).toISOString(),
      };
    },

    clear() {
      records.clear();
    },
  };
}

function verifiedAcceptanceFlashError(code, message, statusCode = 404) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function verifiedGitBranch(value) {
  const branch = String(value ?? "");
  const invalid = !branch
    || branch !== branch.trim()
    || branch.length > 500
    || branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("..")
    || branch.includes("//")
    || branch.includes("@{")
    || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch)
    || branch.split("/").some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"));
  return invalid ? "" : branch;
}

function normalizeVerifiedAcceptanceFlash(payload = {}) {
  const outcome = String(payload?.outcome || "").trim();
  const hubRefreshStatus = String(payload?.hubRefresh?.status || payload?.hubRefresh || "").trim();
  if (!["complete", "pending"].includes(hubRefreshStatus)) {
    throw verifiedAcceptanceFlashError(
      "verified_acceptance_flash_payload_invalid",
      "Verified acceptance flash payload is invalid",
      400,
    );
  }
  if (outcome === "merge") {
    const commit = String(payload?.commit || "").trim().toLowerCase();
    if (GIT_OBJECT_ID_PATTERN.test(commit)) {
      return {
        outcome: "merge",
        commit,
        hubRefresh: { status: hubRefreshStatus },
      };
    }
  }
  if (outcome === "reject") {
    const rejectionBranch = verifiedGitBranch(payload?.rejectionBranch);
    if (rejectionBranch) {
      return {
        outcome: "reject",
        rejectionBranch,
        hubRefresh: { status: hubRefreshStatus },
      };
    }
  }
  throw verifiedAcceptanceFlashError(
    "verified_acceptance_flash_payload_invalid",
    "Verified acceptance flash payload is invalid",
    400,
  );
}

export function createVerifiedAcceptanceFlashStore({
  now = Date.now,
  ttlMs = DEFAULT_VERIFIED_ACCEPTANCE_FLASH_TTL_MS,
} = {}) {
  if (typeof now !== "function") throw new TypeError("Verified acceptance flash clock must be a function");
  const normalizedTtlMs = Number(ttlMs);
  if (!Number.isFinite(normalizedTtlMs) || normalizedTtlMs <= 0) {
    throw new TypeError("Verified acceptance flash TTL must be a positive number");
  }

  const records = new Map();
  const currentTime = () => {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError("Verified acceptance flash clock returned an invalid time");
    return value;
  };
  const prune = (timestamp) => {
    for (const [token, record] of records) {
      if (timestamp >= record.expiresAt) records.delete(token);
    }
  };

  return {
    issue(payload = {}) {
      const timestamp = currentTime();
      prune(timestamp);
      const normalized = normalizeVerifiedAcceptanceFlash(payload);
      const token = randomBytes(24).toString("base64url");
      records.set(token, {
        payload: normalized,
        expiresAt: timestamp + normalizedTtlMs,
      });
      return { token, expiresAt: new Date(timestamp + normalizedTtlMs).toISOString() };
    },

    consume(token) {
      const id = String(token || "").trim();
      const timestamp = currentTime();
      prune(timestamp);
      if (!VERIFIED_ACCEPTANCE_FLASH_TOKEN_PATTERN.test(id)) {
        throw verifiedAcceptanceFlashError(
          "verified_acceptance_flash_invalid",
          "Verified acceptance flash is unavailable",
        );
      }
      const record = records.get(id);
      if (!record) {
        throw verifiedAcceptanceFlashError(
          "verified_acceptance_flash_invalid",
          "Verified acceptance flash is unavailable",
        );
      }
      records.delete(id);
      return record.payload;
    },

    clear() {
      records.clear();
    },
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeEntry(value) {
  const raw = String(value || "").trim().replaceAll("\\", "/");
  if (!raw) return "";
  const folder = raw.endsWith("/");
  const normalized = path.posix.normalize(raw.replace(/^\.\//, "").replace(/\/$/, ""));
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return "";
  return folder ? normalized + "/" : normalized;
}

function normalizePathList(values = []) {
  return uniqueStrings(values.map(normalizeEntry).filter(Boolean));
}

function normalizeRule(rule = {}) {
  const rulePath = normalizeEntry(String(rule.path || "").replace(/\/$/, "") + "/");
  const mode = String(rule.mode || "").trim();
  if (!rulePath || !["recursive-live", "recursive-current", "direct-live", "direct-current"].includes(mode)) return null;
  const normalized = { path: rulePath, mode };
  if (CURRENT_MODES.has(mode)) normalized.files = normalizePathList(rule.files || []);
  return normalized;
}

function normalizeRules(rules = []) {
  const byPath = new Map();
  for (const raw of Array.isArray(rules) ? rules : []) {
    const rule = normalizeRule(raw);
    if (!rule) continue;
    byPath.set(rule.path, rule);
  }
  return [...byPath.values()];
}

function folderEntry(value) {
  return String(value || "").endsWith("/");
}

function entryCovers(cover, target) {
  const left = normalizeEntry(cover);
  const right = normalizeEntry(target);
  if (!left || !right) return false;
  if (left === right) return true;
  if (!folderEntry(left)) return false;
  return right.startsWith(left);
}

function relevantAllowedPaths(settings = {}, watchAllow = [], watchRules = []) {
  const watched = [...watchAllow, ...watchRules.map((rule) => rule.path)];
  return normalizePathList(settings.allowedPaths || []).filter((allowed) => watched.some((item) => entryCovers(allowed, item) || entryCovers(item, allowed)));
}

function normalizeStartup(value = {}, kind = "context") {
  const result = {
    enabled: value?.enabled !== false,
    projectOnly: value?.projectOnly === true,
  };
  if (kind === "context") {
    result.fileNames = uniqueStrings(value?.fileNames || []);
    result.globalPaths = normalizePathList(value?.globalPaths || []);
  } else {
    result.folderNames = normalizePathList(value?.folderNames || []);
  }
  return result;
}

export function ownerReviewScopeFromSettings(settings = {}) {
  const watchAllow = normalizePathList(settings.watchAllow || []);
  const watchRules = normalizeRules(settings.watchRules || []);
  return {
    allowedPaths: relevantAllowedPaths(settings, watchAllow, watchRules),
    watchAllow,
    watchRules,
    startupContext: normalizeStartup(settings.startupContext, "context"),
    startupSkills: normalizeStartup(settings.startupSkills, "skills"),
  };
}

function authorityBase(options = {}) {
  if (options.authorityHome) return path.resolve(options.authorityHome);
  if (process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME) return path.resolve(process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME);
  if (process.env.CONTEXT_ROOM_HUB_HOME) return path.join(path.resolve(process.env.CONTEXT_ROOM_HUB_HOME), "review-authority");
  return path.join(os.homedir(), ".context-room", "hub", "review-authority");
}

function canonicalAuthorityRoot(root) {
  return fs.realpathSync(path.resolve(root));
}

function authorityId(root) {
  return createHash("sha256").update(canonicalAuthorityRoot(root)).digest("hex").slice(0, 24);
}

function resourceAuthorityId(kind, value) {
  return createHash("sha256").update(`${kind}\0${String(value)}`).digest("hex").slice(0, 24);
}

function stableRepositoryRoot(root) {
  const resolved = path.resolve(root);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function repositoryUrl(value) {
  const repository = String(value || "").trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(repository)) return null;
  try { return new URL(repository); } catch { throw new Error("Shared repository must be a valid Git URL or local path"); }
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
  const match = /^(?:([^@/:\s]+)@)?([^@/:\s]+):(.+)$/.exec(repository);
  if (!match) return null;
  const [, username = "", hostname, repositoryPath] = match;
  if (!username && !hostname.includes(".") && hostname.toLowerCase() !== "localhost") return null;
  return { username, hostname: hostname.toLowerCase(), repositoryPath };
}

function githubRepositoryPath(candidate) {
  const repositoryPath = String(candidate || "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const segments = repositoryPath.split("/");
  if (segments.length !== 2 || segments.some((segment) => !/^[a-z0-9._-]+$/i.test(segment))) return "";
  return segments.map((segment) => segment.toLowerCase()).join("/");
}

function contextHubRepositoryIdentity(value) {
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
      if (!parsed.hostname && !parsed.search && !parsed.hash) return `local:${stableRepositoryRoot(fileURLToPath(parsed))}`;
      return `url:${parsed.href}`;
    }
    const githubAlias = parsed.hostname === "github.com"
      && !parsed.search
      && !parsed.hash
      && ((parsed.protocol === "https:" && !parsed.username && !parsed.port)
        || (parsed.protocol === "ssh:" && parsed.username === "git" && (!parsed.port || parsed.port === "22")));
    const githubPath = githubAlias ? githubRepositoryPath(parsed.pathname) : "";
    if (githubPath) return `github:${githubPath}`;
    return `url:${parsed.href}`;
  }
  return `local:${stableRepositoryRoot(repository)}`;
}

function authorityPaths(root, options = {}) {
  const base = authorityBase(options);
  const name = `${authorityId(root)}.json`;
  return {
    base,
    key: path.join(base, "authority.key"),
    state: path.join(base, name),
    backup: path.join(base, `${name}.backup`),
  };
}

function proposalDecisionRepositoryIdentity(repository, options = {}) {
  const explicit = String(options.repositoryIdentity || "").trim();
  return explicit || contextHubRepositoryIdentity(String(repository));
}

function proposalDecisionPathsForIdentity(repositoryIdentity, options = {}) {
  const base = authorityBase(options);
  const name = `proposal-decisions-${resourceAuthorityId("repository", repositoryIdentity)}.json`;
  return {
    base,
    key: path.join(base, "authority.key"),
    state: path.join(base, name),
    backup: path.join(base, `${name}.backup`),
  };
}

function readProposalDecisionState(repository, options = {}) {
  const repositoryTransport = String(repository);
  const repositoryIdentity = proposalDecisionRepositoryIdentity(repositoryTransport, options);
  const paths = proposalDecisionPathsForIdentity(repositoryIdentity, options);
  const records = [];
  const seen = new Set();
  const validateState = (state) => proposalDecisionStateIdentity(state) === repositoryIdentity;
  const inspect = (candidatePaths, { repair = false } = {}) => {
    if (seen.has(candidatePaths.state)) return;
    seen.add(candidatePaths.state);
    const record = repair
      ? (options.lockHeld
        ? recoverSignedStateUnderLock(candidatePaths, { validateState })
        : readSignedStateRepairing(candidatePaths, { validateState }))
      : readSignedState(candidatePaths);
    if (record.integrity === "missing") return;
    if (proposalDecisionStateIdentity(record.state) !== repositoryIdentity) return;
    records.push(record);
  };
  inspect(paths, { repair: true });
  const legacyPaths = proposalDecisionPathsForIdentity(repositoryTransport, options);
  inspect(legacyPaths);
  try {
    for (const name of fs.readdirSync(paths.base)) {
      if (!/^proposal-decisions-[a-f0-9]{24}\.json$/.test(name)) continue;
      const state = path.join(paths.base, name);
      inspect({ base: paths.base, key: paths.key, state, backup: `${state}.backup` });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!records.length) {
    return {
      ...readSignedState(paths),
      repositoryTransport,
      repositoryIdentity,
      legacy: false,
      sourcePaths: [],
    };
  }
  const decisions = {};
  let integrity = records.every((record) => record.integrity === "verified") ? "verified" : "recovered";
  for (const record of records) {
    if (!new Set(["verified", "recovered"]).has(record.integrity)) integrity = record.integrity;
    for (const [key, decision] of Object.entries(record.state?.decisions || {})) {
      if (decisions[key] && JSON.stringify(stableValue(decisions[key])) !== JSON.stringify(stableValue(decision))) {
        integrity = "conflict";
      } else {
        decisions[key] = decision;
      }
    }
  }
  const canonical = records.find((record) => record.paths.state === paths.state);
  return {
    paths,
    state: {
      version: REVIEW_AUTHORITY_VERSION,
      repository: canonical?.state?.repository || records[0].state?.repository || repositoryTransport,
      repositoryIdentity,
      decisions,
      updatedAt: canonical?.state?.updatedAt || records[0].state?.updatedAt || "",
    },
    integrity,
    recoveredFrom: records.find((record) => record.integrity === "recovered")?.recoveredFrom || "",
    repositoryTransport,
    repositoryIdentity,
    legacy: records.some((record) => record.paths.state !== paths.state),
    sourcePaths: records.map((record) => record.paths.state),
  };
}

function proposalDecisionStateIdentity(state) {
  const explicit = String(state?.repositoryIdentity || "").trim();
  if (explicit) return explicit;
  try { return contextHubRepositoryIdentity(String(state?.repository || "")); } catch { return ""; }
}

function trustedStateSafeKind(kind) {
  return String(kind || "state").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "state";
}

function trustedStatePaths(root, kind, options = {}) {
  const base = authorityBase(options);
  const safeKind = trustedStateSafeKind(kind);
  const name = `trusted-${safeKind}-${authorityId(root)}.json`;
  return {
    base,
    key: path.join(base, "authority.key"),
    state: path.join(base, name),
    backup: path.join(base, `${name}.backup`),
  };
}

function ensureAuthorityKey(paths) {
  fs.mkdirSync(paths.base, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.base, 0o700);
  if (!fs.existsSync(paths.key)) {
    const temporary = `${paths.key}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(handle, randomBytes(32));
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      try {
        fs.linkSync(temporary, paths.key);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    } finally {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch {}
      }
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
  fs.chmodSync(paths.key, 0o600);
  return fs.readFileSync(paths.key);
}

function authoritySignature(key, payload) {
  return createHmac("sha256", key).update(JSON.stringify(stableValue(payload))).digest("hex");
}

function signedStateBytes(state) {
  return Buffer.from(JSON.stringify(state, null, 2) + "\n", "utf8");
}

function signedStateDigest(state) {
  return createHash("sha256").update(JSON.stringify(stableValue(state))).digest("hex");
}

function signedStateIsVerified(state, key) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const { signature, ...payload } = state;
  return Boolean(signature) && signature === authoritySignature(key, payload);
}

function fsyncAuthorityDirectory(directory) {
  let handle;
  try {
    handle = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(handle);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function writePrivateFileAtomic(filePath, bytes) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | Number(fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.writeFileSync(handle, bytes);
    fs.fchmodSync(handle, 0o600);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncAuthorityDirectory(directory);
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function readPrivateFileSnapshot(filePath) {
  let handle;
  try {
    handle = fs.openSync(filePath, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(handle, { bigint: true });
    if (!before.isFile() || before.size > BigInt(SIGNED_STATE_MAX_BYTES)) throw new Error(`Signed state file is unsafe: ${filePath}`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(handle, { bigint: true });
    if (offset !== bytes.length
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`Signed state file changed while it was read: ${filePath}`);
    }
    return {
      exists: true,
      bytes,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, bytes: Buffer.alloc(0), hash: null };
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function readSignedFile(filePath, keyPath) {
  let snapshot;
  try {
    snapshot = readPrivateFileSnapshot(filePath);
  } catch {
    return { state: null, integrity: "unsafe-file" };
  }
  if (!snapshot.exists) return { state: null, integrity: "missing" };
  let state;
  try {
    const text = snapshot.bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(snapshot.bytes)) return { state: null, integrity: "invalid-utf8" };
    state = JSON.parse(text);
  } catch {
    return { state: null, integrity: "invalid-json" };
  }
  const { signature, ...payload } = state || {};
  let key;
  try { key = readPrivateFileSnapshot(keyPath); }
  catch { return { state, integrity: "unsafe-key" }; }
  if (!signature || !key.exists) return { state, integrity: "unsigned" };
  const expected = authoritySignature(key.bytes, payload);
  return { state, integrity: signature === expected ? "verified" : "invalid-signature" };
}

function readSignedState(paths) {
  const primary = readSignedFile(paths.state, paths.key);
  const backup = readSignedFile(paths.backup, paths.key);
  if (primary.integrity === "verified") {
    if (backup.integrity === "verified" && signedStateDigest(primary.state) !== signedStateDigest(backup.state)) {
      return {
        paths,
        state: null,
        integrity: "conflict",
        recoveredFrom: "",
        primaryIntegrity: primary.integrity,
        backupIntegrity: backup.integrity,
      };
    }
    return {
      paths,
      ...primary,
      recoveredFrom: "",
      primaryIntegrity: primary.integrity,
      backupIntegrity: backup.integrity,
    };
  }
  if (backup.integrity === "verified") {
    return {
      paths,
      state: backup.state,
      integrity: "recovered",
      recoveredFrom: primary.integrity,
      primaryIntegrity: primary.integrity,
      backupIntegrity: backup.integrity,
    };
  }
  if (primary.integrity === "missing" && backup.integrity !== "missing") {
    return {
      paths,
      ...backup,
      recoveredFrom: primary.integrity,
      primaryIntegrity: primary.integrity,
      backupIntegrity: backup.integrity,
    };
  }
  return {
    paths,
    ...primary,
    recoveredFrom: "",
    primaryIntegrity: primary.integrity,
    backupIntegrity: backup.integrity,
  };
}

function signedStateTransactionPath(paths) {
  return `${paths.state}.transaction`;
}

function signedStateLockOptions() {
  return {
    timeoutMs: PROPOSAL_DECISION_LOCK_TIMEOUT_MS,
    staleMs: PROPOSAL_DECISION_LOCK_STALE_MS,
    busyMessage: "Review authority is busy in another process",
    busyCode: "review_authority_busy",
  };
}

function readSignedStateTransaction(paths, key) {
  const journalPath = signedStateTransactionPath(paths);
  const snapshot = readPrivateFileSnapshot(journalPath);
  if (!snapshot.exists) return null;
  let journal;
  try {
    const text = snapshot.bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(snapshot.bytes)) throw new Error("Signed state transaction is not valid UTF-8");
    journal = JSON.parse(text);
  } catch (error) {
    error.code = "signed_state_transaction_invalid";
    throw error;
  }
  const { signature, ...payload } = journal || {};
  const validBeforeHash = (value) => value === null || /^[a-f0-9]{64}$/.test(String(value || ""));
  if (payload.version !== SIGNED_STATE_TRANSACTION_VERSION
    || payload.kind !== "signed-state-write"
    || payload.stateFile !== path.basename(paths.state)
    || !validBeforeHash(payload.primaryBeforeHash)
    || !validBeforeHash(payload.backupBeforeHash)
    || !/^[a-f0-9]{64}$/.test(String(payload.nextBytesHash || ""))
    || !signedStateIsVerified(payload.nextState, key)
    || signature !== authoritySignature(key, payload)) {
    const error = new Error("Signed state transaction is invalid");
    error.code = "signed_state_transaction_invalid";
    throw error;
  }
  const nextBytes = signedStateBytes(payload.nextState);
  if (createHash("sha256").update(nextBytes).digest("hex") !== payload.nextBytesHash) {
    const error = new Error("Signed state transaction bytes do not match");
    error.code = "signed_state_transaction_invalid";
    throw error;
  }
  return { ...payload, signature, journalPath, nextBytes };
}

function removeSignedStateTransaction(paths) {
  const journalPath = signedStateTransactionPath(paths);
  try {
    fs.unlinkSync(journalPath);
    fsyncAuthorityDirectory(path.dirname(journalPath));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function signedStateConflict(paths, reason = "ambiguous signed state") {
  return {
    paths,
    state: null,
    integrity: "conflict",
    recoveredFrom: reason,
    primaryIntegrity: readSignedFile(paths.state, paths.key).integrity,
    backupIntegrity: readSignedFile(paths.backup, paths.key).integrity,
  };
}

function recoverSignedStateUnderLock(paths, { validateState = () => true } = {}) {
  if (!fs.existsSync(paths.key)) return readSignedState(paths);
  const key = fs.readFileSync(paths.key);
  let transaction;
  try {
    transaction = readSignedStateTransaction(paths, key);
  } catch (error) {
    return signedStateConflict(paths, error.code || "invalid-transaction");
  }
  if (transaction) {
    if (!validateState(transaction.nextState)) return signedStateConflict(paths, "transaction-identity-mismatch");
    let primary;
    let backup;
    try {
      primary = readPrivateFileSnapshot(paths.state);
      backup = readPrivateFileSnapshot(paths.backup);
    } catch {
      return signedStateConflict(paths, "unsafe-transaction-destination");
    }
    const matchesPhase = (snapshot, beforeHash) => snapshot.hash === transaction.nextBytesHash || snapshot.hash === beforeHash;
    if (!matchesPhase(primary, transaction.primaryBeforeHash) || !matchesPhase(backup, transaction.backupBeforeHash)) {
      return signedStateConflict(paths, "transaction-destination-conflict");
    }
    try {
      if (backup.hash !== transaction.nextBytesHash) writePrivateFileAtomic(paths.backup, transaction.nextBytes);
      if (primary.hash !== transaction.nextBytesHash) writePrivateFileAtomic(paths.state, transaction.nextBytes);
      removeSignedStateTransaction(paths);
    } catch {
      return signedStateConflict(paths, "transaction-recovery-failed");
    }
  }
  let current = readSignedState(paths);
  if (current.primaryIntegrity === "missing" && current.backupIntegrity === "verified") {
    if (!validateState(current.state)) return signedStateConflict(paths, "backup-identity-mismatch");
    try {
      writePrivateFileAtomic(paths.state, signedStateBytes(current.state));
    } catch {
      return signedStateConflict(paths, "backup-promotion-failed");
    }
    current = readSignedState(paths);
  }
  return current;
}

function readSignedStateRepairing(paths, options = {}) {
  const current = readSignedState(paths);
  const needsRecovery = fs.existsSync(signedStateTransactionPath(paths))
    || (current.primaryIntegrity === "missing" && current.backupIntegrity === "verified");
  if (!needsRecovery) return current;
  try {
    return withFilesystemLock(
      `${paths.state}.lock`,
      () => recoverSignedStateUnderLock(paths, options),
      signedStateLockOptions(),
    );
  } catch (error) {
    if (error?.code === "filesystem_lock_worker_unsupervised") return current;
    throw error;
  }
}

function writeSignedStateUnderLock(paths, payload, { validateState = () => true } = {}) {
  const key = ensureAuthorityKey(paths);
  const recovered = recoverSignedStateUnderLock(paths, { validateState });
  if (recovered.integrity === "conflict") throw new Error(`Review authority is ${recovered.integrity}`);
  const state = { ...payload, signature: authoritySignature(key, payload) };
  if (!validateState(state)) throw new Error("Review authority identity does not match its destination");
  const bytes = signedStateBytes(state);
  const transactionPayload = {
    version: SIGNED_STATE_TRANSACTION_VERSION,
    kind: "signed-state-write",
    transactionId: randomUUID(),
    stateFile: path.basename(paths.state),
    primaryBeforeHash: readPrivateFileSnapshot(paths.state).hash,
    backupBeforeHash: readPrivateFileSnapshot(paths.backup).hash,
    nextBytesHash: createHash("sha256").update(bytes).digest("hex"),
    nextState: state,
    createdAt: new Date().toISOString(),
  };
  const transaction = {
    ...transactionPayload,
    signature: authoritySignature(key, transactionPayload),
  };
  writePrivateFileAtomic(signedStateTransactionPath(paths), signedStateBytes(transaction));
  writePrivateFileAtomic(paths.backup, bytes);
  writePrivateFileAtomic(paths.state, bytes);
  removeSignedStateTransaction(paths);
  return state;
}

function writeSignedState(paths, payload, options = {}) {
  return withFilesystemLock(
    `${paths.state}.lock`,
    () => writeSignedStateUnderLock(paths, payload, options),
    signedStateLockOptions(),
  );
}

function readAuthority(root, options = {}) {
  const canonicalRoot = canonicalAuthorityRoot(root);
  const paths = authorityPaths(canonicalRoot, options);
  const read = options.readOnly === true ? readRootSignedStateReadOnly : readRootSignedState;
  return read(canonicalRoot, paths, {
    rootField: "projectRoot",
    fileNamePattern: /^[a-f0-9]{24}\.json$/,
  });
}

function writeAuthority(root, scope, { actor = "human-ui", authorityHome = "" } = {}) {
  const options = authorityHome ? { authorityHome } : {};
  const canonicalRoot = canonicalAuthorityRoot(root);
  const paths = authorityPaths(canonicalRoot, options);
  const payload = {
    version: REVIEW_AUTHORITY_VERSION,
    projectRoot: canonicalRoot,
    scope: ownerReviewScopeFromSettings(scope),
    actor: String(actor || "human-ui").slice(0, 120),
    updatedAt: new Date().toISOString(),
  };
  return writeSignedState(paths, payload, {
    validateState: (state) => state?.projectRoot === canonicalRoot,
  });
}

function omitSignedStateSignature(state) {
  const { signature: _signature, ...payload } = state || {};
  return payload;
}

function recordedRootMatchesCanonical(recordedRoot, canonicalRoot) {
  try {
    return canonicalAuthorityRoot(String(recordedRoot || "")) === canonicalRoot;
  } catch {
    return false;
  }
}

function legacyRootStateCandidates(canonicalRoot, paths, {
  rootField,
  kind = "",
  fileNamePattern,
} = {}) {
  let directory;
  try {
    directory = fs.opendirSync(paths.base);
  } catch (error) {
    if (error?.code === "ENOENT") return { candidates: [], overflow: false };
    throw error;
  }
  const relevantNames = new Set();
  let visitedEntries = 0;
  try {
    let entry;
    while ((entry = directory.readSync())) {
      visitedEntries += 1;
      if (visitedEntries > MAX_LEGACY_AUTHORITY_DIRECTORY_ENTRIES) return { candidates: [], overflow: true };
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const stateName = entry.name.endsWith(".backup") ? entry.name.slice(0, -".backup".length) : entry.name;
      if (!fileNamePattern.test(stateName) || path.join(paths.base, stateName) === paths.state) continue;
      relevantNames.add(stateName);
      if (relevantNames.size > MAX_LEGACY_AUTHORITY_SCAN_FILES) return { candidates: [], overflow: true };
    }
  } finally {
    directory.closeSync();
  }
  let scannedBytes = 0n;
  for (const stateName of relevantNames) {
    for (const candidatePath of [path.join(paths.base, stateName), path.join(paths.base, `${stateName}.backup`)]) {
      try {
        const stats = fs.lstatSync(candidatePath, { bigint: true });
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        scannedBytes += stats.size;
        if (scannedBytes > BigInt(MAX_LEGACY_AUTHORITY_SCAN_BYTES)) return { candidates: [], overflow: true };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  const candidates = [];
  for (const stateName of relevantNames) {
    const statePath = path.join(paths.base, stateName);
    const candidatePaths = {
      base: paths.base,
      key: paths.key,
      state: statePath,
      backup: `${statePath}.backup`,
    };
    const primary = readSignedFile(candidatePaths.state, candidatePaths.key);
    const backup = readSignedFile(candidatePaths.backup, candidatePaths.key);
    const matchingPayload = [primary.state, backup.state].some((state) => state
      && recordedRootMatchesCanonical(state[rootField], canonicalRoot)
      && (!kind || state.kind === kind));
    if (!matchingPayload) continue;
    candidates.push({
      paths: candidatePaths,
      record: readSignedState(candidatePaths),
    });
    if (candidates.length > MAX_LEGACY_AUTHORITY_FILES) return { candidates: [], overflow: true };
  }
  return { candidates, overflow: false };
}

function readRootSignedState(root, paths, {
  rootField,
  kind = "",
  fileNamePattern,
} = {}) {
  const canonicalRoot = canonicalAuthorityRoot(root);
  const validateState = (state) => state?.[rootField] === canonicalRoot && (!kind || state?.kind === kind);
  let current = readSignedStateRepairing(paths, { validateState });
  if (current.integrity !== "missing") return current;
  const initialDiscovery = legacyRootStateCandidates(canonicalRoot, paths, { rootField, kind, fileNamePattern });
  if (!initialDiscovery.overflow && !initialDiscovery.candidates.length) return current;
  const legacyFallback = () => {
    if (initialDiscovery.overflow || initialDiscovery.candidates.length !== 1) {
      return signedStateConflict(paths, initialDiscovery.overflow ? "legacy-authority-scan-overflow" : "multiple-legacy-authorities");
    }
    const legacy = initialDiscovery.candidates[0];
    const safeRecovery = legacy.record.integrity === "verified"
      || (legacy.record.integrity === "recovered" && legacy.record.recoveredFrom === "missing");
    if (!safeRecovery
      || !legacy.record.state
      || !recordedRootMatchesCanonical(legacy.record.state[rootField], canonicalRoot)
      || (kind && legacy.record.state.kind !== kind)) {
      return signedStateConflict(paths, "legacy-authority-conflict");
    }
    return {
      ...legacy.record,
      paths,
      integrity: "recovered",
      recoveredFrom: "legacy-authority-unmigrated",
      legacy: true,
      legacyPath: legacy.paths.state,
    };
  };
  try {
    return withFilesystemLock(`${paths.state}.lock`, () => {
      current = recoverSignedStateUnderLock(paths, { validateState });
      if (current.integrity !== "missing") return current;
      const discovery = legacyRootStateCandidates(canonicalRoot, paths, { rootField, kind, fileNamePattern });
      if (discovery.overflow || discovery.candidates.length > 1) {
        return signedStateConflict(paths, discovery.overflow ? "legacy-authority-scan-overflow" : "multiple-legacy-authorities");
      }
      if (!discovery.candidates.length) return current;
      const legacy = discovery.candidates[0];
      const safeRecovery = legacy.record.integrity === "verified"
        || (legacy.record.integrity === "recovered" && legacy.record.recoveredFrom === "missing");
      if (!safeRecovery
        || !legacy.record.state
        || !recordedRootMatchesCanonical(legacy.record.state[rootField], canonicalRoot)
        || (kind && legacy.record.state.kind !== kind)) {
        return signedStateConflict(paths, "legacy-authority-conflict");
      }
      const payload = {
        ...omitSignedStateSignature(legacy.record.state),
        [rootField]: canonicalRoot,
      };
      writeSignedStateUnderLock(paths, payload, { validateState });
      return {
        ...readSignedState(paths),
        migratedFrom: legacy.paths.state,
      };
    }, signedStateLockOptions());
  } catch (error) {
    if (error?.code === "filesystem_lock_worker_unsupervised") return legacyFallback();
    throw error;
  }
}

function readRootSignedStateReadOnly(root, paths, {
  rootField,
  kind = "",
  fileNamePattern,
} = {}) {
  const canonicalRoot = canonicalAuthorityRoot(root);
  const current = readSignedState(paths);
  if (current.integrity !== "missing") return current;
  const discovery = legacyRootStateCandidates(canonicalRoot, paths, { rootField, kind, fileNamePattern });
  if (discovery.overflow || discovery.candidates.length > 1) {
    return signedStateConflict(paths, discovery.overflow ? "legacy-authority-scan-overflow" : "multiple-legacy-authorities");
  }
  if (!discovery.candidates.length) return current;
  const legacy = discovery.candidates[0];
  const safeRecovery = legacy.record.integrity === "verified"
    || (legacy.record.integrity === "recovered" && legacy.record.recoveredFrom === "missing");
  if (!safeRecovery
    || !legacy.record.state
    || !recordedRootMatchesCanonical(legacy.record.state[rootField], canonicalRoot)
    || (kind && legacy.record.state.kind !== kind)) {
    return signedStateConflict(paths, "legacy-authority-conflict");
  }
  return {
    ...legacy.record,
    paths,
    integrity: "recovered",
    recoveredFrom: "legacy-authority-unmigrated",
    legacy: true,
    legacyPath: legacy.paths.state,
  };
}

function rootStateIdentityMatches(record, field, canonicalRoot) {
  if (record.state?.[field] === canonicalRoot) return true;
  return record.legacy === true && recordedRootMatchesCanonical(record.state?.[field], canonicalRoot);
}

function stateDigest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function authorizeOwnerTrustedState(root, kind, value, options = {}) {
  const canonicalRoot = canonicalAuthorityRoot(root);
  return writeSignedState(trustedStatePaths(canonicalRoot, kind, options), {
    version: REVIEW_AUTHORITY_VERSION,
    resourceRoot: canonicalRoot,
    kind: String(kind),
    stateHash: stateDigest(value),
    actor: String(options.actor || "human-ui").slice(0, 120),
    updatedAt: new Date().toISOString(),
  }, {
    validateState: (state) => state?.resourceRoot === canonicalRoot && state?.kind === String(kind),
  });
}

export function inspectOwnerTrustedState(root, kind, value, options = {}) {
  const canonicalRoot = canonicalAuthorityRoot(root);
  const paths = trustedStatePaths(canonicalRoot, kind, options);
  const safeKind = trustedStateSafeKind(kind);
  const read = options.readOnly === true ? readRootSignedStateReadOnly : readRootSignedState;
  const record = read(canonicalRoot, paths, {
    rootField: "resourceRoot",
    kind: String(kind),
    fileNamePattern: new RegExp(`^trusted-${safeKind}-[a-f0-9]{24}\\.json$`),
  });
  if (!["verified", "recovered"].includes(record.integrity)) {
    return { configured: record.integrity !== "missing", trusted: false, integrity: record.integrity, recoveredFrom: record.recoveredFrom || "", authorityPath: record.paths.state };
  }
  const identityMatches = rootStateIdentityMatches(record, "resourceRoot", canonicalRoot) && record.state?.kind === String(kind);
  const hashMatches = record.state?.stateHash === stateDigest(value);
  return {
    configured: true,
    trusted: identityMatches && hashMatches,
    integrity: record.integrity,
    recoveredFrom: record.recoveredFrom || "",
    identityMatches,
    hashMatches,
    authorityPath: record.paths.state,
    updatedAt: record.state?.updatedAt || null,
  };
}

export function authorizeOwnerReviewScope(root, settings = {}, options = {}) {
  return writeAuthority(root, settings, options);
}

export function ownerReviewAuthorityLockPaths(root, { trustedKinds = [], ...options } = {}) {
  const canonicalRoot = canonicalAuthorityRoot(root);
  return [
    `${authorityPaths(canonicalRoot, options).state}.lock`,
    ...uniqueStrings(trustedKinds).map((kind) => `${trustedStatePaths(canonicalRoot, kind, options).state}.lock`),
  ];
}

export function recordOwnerProposalDecision(repository, decision = {}, options = {}) {
  const repositoryTransport = String(repository);
  const repositoryIdentity = proposalDecisionRepositoryIdentity(repositoryTransport, options);
  const proposal = String(decision.proposal || "").trim();
  const proposalHead = String(decision.proposalHead || "").trim().toLowerCase();
  const outcome = String(decision.decision || "").trim();
  if (!proposal || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(proposalHead)) {
    throw new Error("A proposal branch and exact proposal head are required");
  }
  if (!new Set(["accepted", "rejected"]).has(outcome)) throw new Error("Proposal decision must be accepted or rejected");
  const archiveRef = outcome === "rejected" ? String(decision.archiveRef || "").trim() : "";
  const acceptedCommit = outcome === "accepted" ? String(decision.acceptedCommit || "").trim().toLowerCase() : "";
  if (outcome === "rejected" && !archiveRef) throw new Error("A rejected proposal decision requires its exact archive ref");
  if (outcome === "accepted" && !GIT_OBJECT_ID_PATTERN.test(acceptedCommit)) {
    throw new Error("An accepted proposal decision requires its exact accepted commit");
  }
  const paths = proposalDecisionPathsForIdentity(repositoryIdentity, options);
  return withFilesystemLock(`${paths.state}.lock`, () => {
    const current = readProposalDecisionState(repositoryTransport, { ...options, repositoryIdentity, lockHeld: true });
    if (!["missing", "verified"].includes(current.integrity)) {
      throw new Error(`Proposal decision authority is ${current.integrity}`);
    }
    if (current.state && proposalDecisionStateIdentity(current.state) !== repositoryIdentity) {
      throw new Error("Proposal decision authority repository does not match");
    }
    const decisions = current.state?.decisions && typeof current.state.decisions === "object" && !Array.isArray(current.state.decisions)
      ? { ...current.state.decisions }
      : {};
    const key = createHash("sha256").update(`${proposal}\0${proposalHead}`).digest("hex");
    const existing = decisions[key] || null;
    if (existing) {
      const sameDecision = existing.proposal === proposal
        && existing.proposalHead === proposalHead
        && existing.decision === outcome
        && String(existing.archiveRef || "") === archiveRef
        && String(existing.acceptedCommit || "").toLowerCase() === acceptedCommit;
      if (!sameDecision) {
        const error = new Error(`Proposal ${proposal} at ${proposalHead} already has a different terminal decision`);
        error.code = "proposal_decision_conflict";
        error.statusCode = 409;
        error.details = {
          proposal,
          proposalHead,
          existingDecision: String(existing.decision || ""),
          requestedDecision: outcome,
        };
        throw error;
      }
      if (!current.legacy && current.paths.state === paths.state) return current.state;
      return writeSignedStateUnderLock(paths, {
        ...current.state,
        version: REVIEW_AUTHORITY_VERSION,
        repository: current.state?.repository || repositoryTransport,
        repositoryIdentity,
        decisions,
        updatedAt: new Date().toISOString(),
      }, {
        validateState: (state) => proposalDecisionStateIdentity(state) === repositoryIdentity,
      });
    }
    decisions[key] = {
      proposal,
      proposalHead,
      decision: outcome,
      archiveRef,
      acceptedCommit,
      actor: String(options.actor || decision.actor || "human-ui").slice(0, 120),
      decidedAt: new Date().toISOString(),
    };
    return writeSignedStateUnderLock(paths, {
      version: REVIEW_AUTHORITY_VERSION,
      repository: current.state?.repository || repositoryTransport,
      repositoryIdentity,
      decisions,
      updatedAt: new Date().toISOString(),
    }, {
      validateState: (state) => proposalDecisionStateIdentity(state) === repositoryIdentity,
    });
  }, {
    timeoutMs: PROPOSAL_DECISION_LOCK_TIMEOUT_MS,
    staleMs: PROPOSAL_DECISION_LOCK_STALE_MS,
    busyMessage: "Proposal decision authority is busy in another process",
    busyCode: "proposal_decision_authority_busy",
  });
}

export function inspectOwnerProposalDecisions(repository, options = {}) {
  const record = readProposalDecisionState(repository, options);
  const identityMatches = proposalDecisionStateIdentity(record.state) === record.repositoryIdentity;
  if (!["verified", "recovered"].includes(record.integrity) || !identityMatches) {
    return {
      integrity: ["verified", "recovered"].includes(record.integrity) ? "repository-mismatch" : record.integrity,
      writable: record.integrity === "missing",
      decisions: [],
      authorityPath: record.paths.state,
    };
  }
  return {
    integrity: record.integrity,
    writable: record.integrity === "verified",
    recoveredFrom: record.recoveredFrom || "",
    decisions: Object.values(record.state.decisions || {}),
    authorityPath: record.paths.state,
  };
}

function mergeRule(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.mode === right.mode) {
    if (!CURRENT_MODES.has(left.mode)) return left;
    return { ...left, files: normalizePathList([...(left.files || []), ...(right.files || [])]) };
  }
  if (left.mode === "recursive-live" || right.mode === "recursive-live") return { path: left.path, mode: "recursive-live" };
  if (LIVE_MODES.has(left.mode) && LIVE_MODES.has(right.mode)) return { path: left.path, mode: "recursive-live" };
  if (LIVE_MODES.has(left.mode) || LIVE_MODES.has(right.mode)) {
    const live = LIVE_MODES.has(left.mode) ? left : right;
    const current = live === left ? right : left;
    if (live.mode === "direct-live" && current.mode === "direct-current") return { path: left.path, mode: "direct-live" };
    return { path: left.path, mode: "recursive-live" };
  }
  const files = normalizePathList([...(left.files || []), ...(right.files || [])]);
  return { path: left.path, mode: left.mode === "recursive-current" || right.mode === "recursive-current" ? "recursive-current" : "direct-current", files };
}

function mergeRules(current = [], protectedRules = []) {
  const byPath = new Map();
  for (const rule of [...normalizeRules(current), ...normalizeRules(protectedRules)]) {
    byPath.set(rule.path, mergeRule(byPath.get(rule.path), rule));
  }
  return [...byPath.values()];
}

function protectedDescendantRequirement(candidate, protectedScope = {}) {
  if ((protectedScope.watchRules || []).some((rule) => rule.path === candidate.path)) return null;
  let requirement = null;
  for (const watchedPath of protectedScope.watchAllow || []) {
    if (!folderEntry(watchedPath) || candidate.path === watchedPath || !entryCovers(watchedPath, candidate.path)) continue;
    requirement = mergeRule(requirement, { path: candidate.path, mode: "recursive-live" });
  }
  for (const protectedRule of protectedScope.watchRules || []) {
    if (candidate.path === protectedRule.path || !entryCovers(protectedRule.path, candidate.path)) continue;
    if (protectedRule.mode === "recursive-live") {
      requirement = mergeRule(requirement, { path: candidate.path, mode: "recursive-live" });
      continue;
    }
    if (protectedRule.mode === "recursive-current") {
      const files = (protectedRule.files || []).filter((file) => entryCovers(candidate.path, file));
      if (files.length) requirement = mergeRule(requirement, { path: candidate.path, mode: "recursive-current", files });
    }
  }
  return requirement;
}

function protectDescendantRuleOverrides(rules = [], protectedScope = {}) {
  return normalizeRules(rules).map((candidate) => mergeRule(candidate, protectedDescendantRequirement(candidate, protectedScope)));
}

function mergeStartup(current = {}, protectedStartup = {}, kind = "context") {
  const left = normalizeStartup(current, kind);
  const right = normalizeStartup(protectedStartup, kind);
  const result = {
    ...current,
    enabled: left.enabled || right.enabled,
    projectOnly: left.projectOnly && right.projectOnly,
  };
  if (kind === "context") {
    result.fileNames = uniqueStrings([...left.fileNames, ...right.fileNames]);
    result.globalPaths = normalizePathList([...left.globalPaths, ...right.globalPaths]);
  } else {
    result.folderNames = normalizePathList([...left.folderNames, ...right.folderNames]);
  }
  return result;
}

function applyProtectedScope(settings = {}, protectedScope = {}) {
  const mergedRules = mergeRules(settings.watchRules, protectedScope.watchRules);
  return {
    ...settings,
    allowedPaths: normalizePathList([...(settings.allowedPaths || []), ...(protectedScope.allowedPaths || [])]),
    watchAllow: normalizePathList([...(settings.watchAllow || []), ...(protectedScope.watchAllow || [])]),
    watchRules: protectDescendantRuleOverrides(mergedRules, protectedScope),
    startupContext: mergeStartup(settings.startupContext, protectedScope.startupContext, "context"),
    startupSkills: mergeStartup(settings.startupSkills, protectedScope.startupSkills, "skills"),
  };
}

function ruleCovers(candidate, required) {
  if (!candidate || !required) return false;
  if (!entryCovers(candidate.path, required.path)) return false;
  if (required.mode === "recursive-live") return candidate.mode === "recursive-live";
  if (required.mode === "direct-live") return candidate.mode === "direct-live" || candidate.mode === "recursive-live";
  const requiredFiles = required.files || [];
  if (LIVE_MODES.has(candidate.mode)) return requiredFiles.every((file) => entryCovers(candidate.path, file));
  const candidateFiles = new Set(candidate.files || []);
  return requiredFiles.every((file) => candidateFiles.has(file));
}

function scopeReductions(protectedScope, settings) {
  const current = ownerReviewScopeFromSettings(settings);
  const reductions = [];
  for (const required of protectedScope.allowedPaths || []) {
    if (!(current.allowedPaths || []).some((candidate) => entryCovers(candidate, required))) reductions.push({ field: "allowedPaths", value: required });
  }
  for (const required of protectedScope.watchAllow || []) {
    const coveredByPath = (current.watchAllow || []).some((candidate) => entryCovers(candidate, required));
    const coveredByRule = (current.watchRules || []).some((candidate) => entryCovers(candidate.path, required) && LIVE_MODES.has(candidate.mode));
    if (!coveredByPath && !coveredByRule) reductions.push({ field: "watchAllow", value: required });
  }
  for (const required of protectedScope.watchRules || []) {
    if (!(current.watchRules || []).some((candidate) => ruleCovers(candidate, required))) reductions.push({ field: "watchRules", value: required.path, mode: required.mode });
  }
  for (const candidate of current.watchRules || []) {
    const descendantRequirement = protectedDescendantRequirement(candidate, protectedScope);
    if (descendantRequirement && !ruleCovers(candidate, descendantRequirement)) {
      reductions.push({ field: "watchRules", value: candidate.path, mode: candidate.mode, reason: "narrower-descendant-override" });
    }
  }
  for (const [name, protectedStartup, currentStartup] of [
    ["startupContext", protectedScope.startupContext || {}, current.startupContext || {}],
    ["startupSkills", protectedScope.startupSkills || {}, current.startupSkills || {}],
  ]) {
    if (protectedStartup.enabled && !currentStartup.enabled) reductions.push({ field: `${name}.enabled`, value: false });
    if (protectedStartup.projectOnly === false && currentStartup.projectOnly !== false) reductions.push({ field: `${name}.projectOnly`, value: true });
    const listFields = name === "startupContext" ? ["fileNames", "globalPaths"] : ["folderNames"];
    for (const field of listFields) {
      for (const value of protectedStartup[field] || []) {
        if (!(currentStartup[field] || []).includes(value)) reductions.push({ field: `${name}.${field}`, value });
      }
    }
  }
  return reductions;
}

export function inspectOwnerReviewScope(root, settings = {}, options = {}) {
  const canonicalRoot = canonicalAuthorityRoot(root);
  const record = readAuthority(root, options);
  if (record.integrity === "missing") {
    return { configured: false, tampered: false, severity: "none", integrity: record.integrity, reductions: [], authorityPath: record.paths.state };
  }
  if (!["verified", "recovered"].includes(record.integrity) || !rootStateIdentityMatches(record, "projectRoot", canonicalRoot)) {
    return { configured: true, tampered: true, severity: "critical", integrity: record.integrity, reductions: [{ field: "authority", value: record.integrity }], authorityPath: record.paths.state };
  }
  const reductions = scopeReductions(record.state.scope || {}, settings);
  if (record.integrity === "recovered") reductions.unshift({ field: "authority", value: `recovered-from-${record.recoveredFrom || "invalid-primary"}` });
  return {
    configured: true,
    tampered: reductions.length > 0,
    severity: reductions.length ? "critical" : "none",
    integrity: record.integrity,
    reductions,
    authorityPath: record.paths.state,
    updatedAt: record.state.updatedAt || null,
    actor: record.state.actor || "",
  };
}

export function effectiveOwnerReviewScope(root, settings = {}, options = {}) {
  const canonicalRoot = canonicalAuthorityRoot(root);
  let record = readAuthority(root, options);
  if (record.integrity === "missing") {
    if (options.readOnly === true) return settings;
    authorizeOwnerReviewScope(root, settings, { ...options, actor: options.bootstrapActor || "bootstrap" });
    record = readAuthority(root, options);
  }
  if (!["verified", "recovered"].includes(record.integrity) || !rootStateIdentityMatches(record, "projectRoot", canonicalRoot)) {
    const error = new Error(`Owner review authority is unavailable or invalid: ${record.integrity}`);
    error.code = "review_authority_unavailable";
    error.integrity = record.integrity;
    throw error;
  }
  return applyProtectedScope(settings, record.state.scope || {});
}

export function reviewScopeReductions(beforeSettings = {}, afterSettings = {}) {
  return scopeReductions(ownerReviewScopeFromSettings(beforeSettings), afterSettings);
}
