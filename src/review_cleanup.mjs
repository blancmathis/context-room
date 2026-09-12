import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withFilesystemLock } from "./filesystem_lock.mjs";
import { authorizeOwnerTrustedState, inspectOwnerTrustedState } from "./review_authority.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const DAY = 86400000;
const DEFAULT_POLICY = { enabled: false, days: 30, projectIds: [] };

function paths(root) {
  const directory = path.join(fs.realpathSync(root), ".context-room", "review-cleanup");
  for (const file of [path.dirname(directory), directory]) {
    fs.mkdirSync(file, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Review cleanup state cannot use symbolic links.");
  }
  return directory;
}

function read(directory, name, fallback) {
  let fd;
  try { fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  try { return JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
}

function write(directory, name, value) {
  const temporary = path.join(directory, randomUUID() + ".tmp");
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, path.join(directory, name)); } finally { fs.rmSync(temporary, { force: true }); }
}

function policyValue(value) {
  if (typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.days) || value.days < 1 || value.days > 36500
    || !Array.isArray(value.projectIds) || value.projectIds.some((id) => typeof id !== "string" || !id || id.length > 300)) throw new Error("Choose an enabled state, a positive number of days, and exact project IDs.");
  return { enabled: value.enabled, days: value.days, projectIds: [...new Set(value.projectIds)].sort() };
}

export function readReviewCleanupPolicy(root) {
  const directory = path.join(path.resolve(root), ".context-room", "review-cleanup");
  if (!fs.existsSync(directory)) return { ...DEFAULT_POLICY };
  const state = read(paths(root), "policy.json", null);
  if (!state) return { ...DEFAULT_POLICY };
  if (!inspectOwnerTrustedState(root, "review-cleanup-policy", state, { readOnly: true }).trusted) throw new Error("The cleanup rule lacks its human authorization. No automatic rejection is allowed.");
  return policyValue(state);
}

/** Called only from the owner-authenticated interface, never generic settings or agent commands. */
export function writeReviewCleanupPolicy(root, value) {
  const directory = paths(root), state = policyValue(value);
  return withFilesystemLock(path.join(directory, "state.lock"), () => {
    authorizeOwnerTrustedState(root, "review-cleanup-policy", state);
    write(directory, "policy.json", state);
    return state;
  });
}

function planUnderLock(root, directory, items, options) {
  const policy = policyValue({ ...DEFAULT_POLICY, ...options });
  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(now)) throw new Error("A valid observation time is required.");
  const previous = read(directory, "observations.json", {});
  const authority = inspectOwnerTrustedState(root, "review-cleanup-observations", previous, { readOnly: true });
  if (authority.configured && !authority.trusted) throw new Error("Cleanup observation history has changed outside the human-authorized store. No rejection is allowed.");
  const trusted = authority.trusted;
  const observations = {}, selected = [];
  for (const item of items) {
    if (!item.id || !item.revision || item.draft || item.terminal) continue;
    const existing = trusted ? previous[item.id] : null;
    const submittedAt = Date.parse(item.submittedAt || "");
    const initialTime = Number.isFinite(submittedAt) && submittedAt <= now ? submittedAt : now;
    const observedAt = existing?.revision === item.revision ? Math.min(now, existing.observedAt) : existing ? now : initialTime;
    observations[item.id] = { revision: item.revision, observedAt };
    if (item.available === false || (policy.projectIds.length && !policy.projectIds.includes(item.projectId))) continue;
    if (now - observedAt < policy.days * DAY) continue;
    selected.push({ ...item, observedAt });
  }
  authorizeOwnerTrustedState(root, "review-cleanup-observations", observations);
  write(directory, "observations.json", observations);
  selected.sort((a, b) => a.id.localeCompare(b.id));
  // Bound each human-visible plan. A following plan can handle the rest.
  const candidates = selected.slice(0, 100);
  return { revision: digest({ policy, items: candidates }), days: policy.days, projectIds: policy.projectIds,
    ageBasis: "time-since-this-version-was-observed", items: candidates, remaining: Math.max(0, selected.length - 100) };
}

export function previewReviewCleanup(root, items, options = {}) {
  const directory = paths(root);
  return withFilesystemLock(path.join(directory, "state.lock"), () => planUnderLock(root, directory, items, options));
}

export function applyReviewCleanup(root, items, { expectedRevision, automatic = false, reject, ...options } = {}) {
  const directory = paths(root);
  return withFilesystemLock(path.join(directory, "state.lock"), () => {
    const policy = automatic ? readReviewCleanupPolicy(root) : options;
    if (automatic && !policy.enabled) return { applied: [], errors: [], disabled: true };
    const plan = planUnderLock(root, directory, items, { ...options, ...policy });
    if (!automatic && expectedRevision !== plan.revision) throw new Error("The cleanup selection changed. Preview it again before rejecting anything.");
    const result = { id: randomUUID(), at: new Date(options.now ?? Date.now()).toISOString(), automatic, revision: plan.revision, applied: [], errors: [] };
    for (const item of plan.items) {
      write(directory, `receipt-${result.id}.json`, { ...result, processing: item.id });
      try {
        const receipt = reject(item);
        result.applied.push({ id: item.id, revision: item.revision, receipt });
      } catch (error) { result.errors.push({ id: item.id, revision: item.revision, message: error.message }); }
      write(directory, `receipt-${result.id}.json`, result);
    }
    if (result.applied.length || result.errors.length) write(directory, `receipt-${result.id}.json`, result);
    return result;
  });
}

/** Informational receipts only: these never authorize subsequent rejection. */
export function recentReviewCleanupReceipts(root) {
  const directory = paths(root);
  return fs.readdirSync(directory).filter(name => /^receipt-[a-f0-9-]+\.json$/.test(name)).map(name => {
    const value = read(directory, name, null);
    return value ? { at: value.at, automatic: Boolean(value.automatic), applied: value.applied?.length || 0, processing: value.processing || null, errors: (value.errors || []).map(item => ({ id: item.id, message: item.message })) } : null;
  }).filter(Boolean).sort((a,b) => String(b.at).localeCompare(String(a.at))).slice(0, 10);
}
