import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REVIEW_AUTHORITY_VERSION = 1;
const LIVE_MODES = new Set(["recursive-live", "direct-live"]);
const CURRENT_MODES = new Set(["recursive-current", "direct-current"]);

export const HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY = Object.freeze({
  confirmationsRequired: 2,
  appliesTo: Object.freeze(["multi-file-batch", "proposal-terminal"]),
  singleFileDecision: "direct-human-ui",
  firstConfirmation: "Ask the user explicitly whether they want the exact multi-file batch or terminal proposal decision.",
  secondConfirmation: "After the first yes, restate the exact action, project, proposal or file scope, and effects, then ask again.",
  mutationRule: "Do nothing unless the user gives a second separate, unambiguous yes.",
  instruction: "Before a multi-file batch or terminal proposal decision, an agent must ask the user explicitly. After the first yes, it must restate the exact action, project, proposal or file scope, and effects, ask again, and do nothing without a second separate, unambiguous yes. Single-file decisions stay in the direct human UI and never become agent-facing commands.",
});

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

function authorityId(root) {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
}

function resourceAuthorityId(kind, value) {
  return createHash("sha256").update(`${kind}\0${String(value)}`).digest("hex").slice(0, 24);
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

function proposalDecisionPaths(repository, options = {}) {
  const base = authorityBase(options);
  const name = `proposal-decisions-${resourceAuthorityId("repository", repository)}.json`;
  return {
    base,
    key: path.join(base, "authority.key"),
    state: path.join(base, name),
    backup: path.join(base, `${name}.backup`),
  };
}

function trustedStatePaths(root, kind, options = {}) {
  const base = authorityBase(options);
  const safeKind = String(kind || "state").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "state";
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
  if (!fs.existsSync(paths.key)) fs.writeFileSync(paths.key, randomBytes(32), { mode: 0o600 });
  fs.chmodSync(paths.key, 0o600);
  return fs.readFileSync(paths.key);
}

function authoritySignature(key, payload) {
  return createHmac("sha256", key).update(JSON.stringify(stableValue(payload))).digest("hex");
}

function readSignedFile(filePath, keyPath) {
  if (!fs.existsSync(filePath)) return { state: null, integrity: "missing" };
  let state;
  try {
    state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { state: null, integrity: "invalid-json" };
  }
  const { signature, ...payload } = state || {};
  if (!signature || !fs.existsSync(keyPath)) return { state, integrity: "unsigned" };
  const expected = authoritySignature(fs.readFileSync(keyPath), payload);
  return { state, integrity: signature === expected ? "verified" : "invalid-signature" };
}

function readSignedState(paths) {
  const primary = readSignedFile(paths.state, paths.key);
  if (primary.integrity === "verified") return { paths, ...primary, recoveredFrom: "" };
  const backup = readSignedFile(paths.backup, paths.key);
  if (backup.integrity === "verified") {
    return { paths, state: backup.state, integrity: "recovered", recoveredFrom: primary.integrity };
  }
  return { paths, ...primary, recoveredFrom: "" };
}

function readAuthority(root, options = {}) {
  const paths = authorityPaths(root, options);
  return readSignedState(paths);
}

function writeSignedState(paths, payload) {
  const key = ensureAuthorityKey(paths);
  const state = { ...payload, signature: authoritySignature(key, payload) };
  for (const destination of [paths.backup, paths.state]) {
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  }
  return state;
}

function stateDigest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function authorizeOwnerTrustedState(root, kind, value, options = {}) {
  return writeSignedState(trustedStatePaths(root, kind, options), {
    version: REVIEW_AUTHORITY_VERSION,
    resourceRoot: path.resolve(root),
    kind: String(kind),
    stateHash: stateDigest(value),
    actor: String(options.actor || "human-ui").slice(0, 120),
    updatedAt: new Date().toISOString(),
  });
}

export function inspectOwnerTrustedState(root, kind, value, options = {}) {
  const record = readSignedState(trustedStatePaths(root, kind, options));
  if (!["verified", "recovered"].includes(record.integrity)) {
    return { configured: record.integrity !== "missing", trusted: false, integrity: record.integrity, recoveredFrom: record.recoveredFrom || "", authorityPath: record.paths.state };
  }
  const identityMatches = record.state?.resourceRoot === path.resolve(root) && record.state?.kind === String(kind);
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

function writeAuthority(root, scope, { actor = "human-ui", authorityHome = "" } = {}) {
  const options = authorityHome ? { authorityHome } : {};
  const paths = authorityPaths(root, options);
  const payload = {
    version: REVIEW_AUTHORITY_VERSION,
    projectRoot: path.resolve(root),
    scope: ownerReviewScopeFromSettings(scope),
    actor: String(actor || "human-ui").slice(0, 120),
    updatedAt: new Date().toISOString(),
  };
  return writeSignedState(paths, payload);
}

export function authorizeOwnerReviewScope(root, settings = {}, options = {}) {
  return writeAuthority(root, settings, options);
}

export function recordOwnerProposalDecision(repository, decision = {}, options = {}) {
  const proposal = String(decision.proposal || "").trim();
  const proposalHead = String(decision.proposalHead || "").trim().toLowerCase();
  const outcome = String(decision.decision || "").trim();
  if (!proposal || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(proposalHead)) {
    throw new Error("A proposal branch and exact proposal head are required");
  }
  if (!new Set(["accepted", "rejected"]).has(outcome)) throw new Error("Proposal decision must be accepted or rejected");
  const paths = proposalDecisionPaths(repository, options);
  const current = readSignedState(paths);
  if (!["missing", "verified"].includes(current.integrity)) {
    throw new Error(`Proposal decision authority is ${current.integrity}`);
  }
  const decisions = current.state?.decisions && typeof current.state.decisions === "object"
    ? current.state.decisions
    : {};
  const key = createHash("sha256").update(`${proposal}\0${proposalHead}`).digest("hex");
  decisions[key] = {
    proposal,
    proposalHead,
    decision: outcome,
    archiveRef: String(decision.archiveRef || "").trim(),
    acceptedCommit: String(decision.acceptedCommit || "").trim().toLowerCase(),
    actor: String(options.actor || decision.actor || "human-ui").slice(0, 120),
    decidedAt: new Date().toISOString(),
  };
  return writeSignedState(paths, {
    version: REVIEW_AUTHORITY_VERSION,
    repository: String(repository),
    decisions,
    updatedAt: new Date().toISOString(),
  });
}

export function inspectOwnerProposalDecisions(repository, options = {}) {
  const record = readSignedState(proposalDecisionPaths(repository, options));
  if (!["verified", "recovered"].includes(record.integrity) || record.state?.repository !== String(repository)) {
    return {
      integrity: ["verified", "recovered"].includes(record.integrity) ? "repository-mismatch" : record.integrity,
      decisions: [],
      authorityPath: record.paths.state,
    };
  }
  return {
    integrity: record.integrity,
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
  const record = readAuthority(root, options);
  if (record.integrity === "missing") {
    return { configured: false, tampered: false, severity: "none", integrity: record.integrity, reductions: [], authorityPath: record.paths.state };
  }
  if (!["verified", "recovered"].includes(record.integrity) || record.state?.projectRoot !== path.resolve(root)) {
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
  let record = readAuthority(root, options);
  if (record.integrity === "missing") {
    authorizeOwnerReviewScope(root, settings, { ...options, actor: options.bootstrapActor || "bootstrap" });
    record = readAuthority(root, options);
  }
  if (!["verified", "recovered"].includes(record.integrity) || record.state?.projectRoot !== path.resolve(root)) {
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
