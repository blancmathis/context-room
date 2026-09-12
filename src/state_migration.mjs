import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withFilesystemLock } from "./filesystem_lock.mjs";

export const DOCUMENT_WORKFLOW_VERSION = 1;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const CONTROL_FILES = ["config.json", "review-state.json", "review-ledger.json", "review-gate.json", "shared-context.json", "shared-review.json"];
const conflict = (message) => { const error = new Error(message); error.code = "migration_conflict"; throw error; };
function controlPath(root, rel) {
  let current = fs.realpathSync(root);
  for (const part of rel.split("/")) {
    if (!part || part === "." || part === "..") conflict("Invalid migration path.");
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) conflict("Migration does not follow symbolic control paths."); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return current;
}
function read(root, rel) {
  let fd; try { fd = fs.openSync(controlPath(root, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try { if (!fs.fstatSync(fd).isFile()) conflict("A migration control file is not regular."); return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
function write(root, rel, value) {
  const target = controlPath(root, rel); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + "." + randomUUID() + ".tmp", fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, controlPath(root, rel));
}

/** Read-only compatibility inventory. Existing accepted evidence is never promoted or rewritten. */
export function planStateMigration(root) {
  root = fs.realpathSync(root);
  const stats = fs.statSync(root), rootIdentity = `${stats.dev}:${stats.ino}`;
  const existing = read(root, ".context-room/workflow-state.json");
  if (existing) {
    const state = JSON.parse(existing.toString());
    if (state.version !== DOCUMENT_WORKFLOW_VERSION || state.rootIdentity !== rootIdentity) conflict("Unsupported workflow state or replaced project root.");
    return { version: DOCUMENT_WORKFLOW_VERSION, root, rootIdentity, migrated: true, revision: digest(existing), files: [], warnings: [] };
  }
  const files = CONTROL_FILES.flatMap((name) => {
    const rel = `.context-room/${name}`, bytes = read(root, rel);
    return bytes ? [{ path: rel, hash: digest(bytes), bytes: bytes.length }] : [];
  });
  const rawReview = read(root, ".context-room/review-state.json"), warnings = [];
  if (rawReview) {
    const state = JSON.parse(rawReview.toString());
    for (const [rel, review] of Object.entries(state.reviews || {})) {
      if (["needs_changes", "snoozed"].includes(review?.status) && !review.acceptedVersion) warnings.push({ path: rel, reason: "Legacy review has no separate accepted version. It remains unavailable to accepted-only reads until reviewed; Git and existing baselines are preserved." });
    }
  }
  const plan = { version: DOCUMENT_WORKFLOW_VERSION, root, rootIdentity, migrated: false, files, warnings,
    preservedInPlace: ["review-baselines", "local-proposals", "Shared proposal worktrees", "Hub registry", "native provider links", "unknown configuration fields"] };
  return { ...plan, revision: digest(JSON.stringify(plan)) };
}

export function applyStateMigration(root, { expectedRevision } = {}) {
  const initial = planStateMigration(root);
  const finishJournal = (current) => {
    const base = `.context-room/migrations/workflow-v${DOCUMENT_WORKFLOW_VERSION}`;
    const journalBytes = read(root, `${base}/journal.json`);
    if (!journalBytes) conflict("Migration completion has no recoverable journal.");
    const journal = JSON.parse(journalBytes.toString());
    if (journal.status !== "complete") {
      if (journal.plan?.rootIdentity !== current.rootIdentity) conflict("Migration journal belongs to a different project root.");
      for (const file of journal.plan.files) {
        const backup = read(root, `${base}/objects/${file.hash}`);
        if (!backup || digest(backup) !== file.hash) conflict("Migration recovery backup is damaged.");
      }
      write(root, `${base}/journal.json`, { ...journal, status: "complete", state: JSON.parse(read(root, ".context-room/workflow-state.json").toString()), recovered: true });
    }
    return { ...current, idempotent: true };
  };
  const directory = controlPath(root, ".context-room/migrations"); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return withFilesystemLock(path.join(directory, "state.lock"), () => {
    const current = planStateMigration(root);
    if (current.migrated) return finishJournal(current);
    if (!expectedRevision || current.revision !== expectedRevision) conflict("Project state changed after migration preview. No legacy state was replaced.");
    const base = `.context-room/migrations/workflow-v${DOCUMENT_WORKFLOW_VERSION}`;
    write(root, `${base}/journal.json`, { status: "preparing", plan: current });
    for (const file of current.files) {
      const bytes = read(root, file.path);
      if (!bytes || digest(bytes) !== file.hash) conflict(`Changed migration source: ${file.path}`);
      const backup = controlPath(root, `${base}/objects/${file.hash}`); fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(backup, bytes, { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      if (digest(read(root, `${base}/objects/${file.hash}`)) !== file.hash) conflict("A migration backup is damaged.");
    }
    if (planStateMigration(root).revision !== current.revision) conflict("State changed while preparing migration backups.");
    const state = { version: DOCUMENT_WORKFLOW_VERSION, rootIdentity: current.rootIdentity, migratedAt: new Date().toISOString(),
      from: "compatible legacy state", backup: base, warnings: current.warnings,
      behavior: { normalReads: "accepted-only", localChanges: "isolated-proposals", cleanup: "disabled-unless-human-authorized" } };
    write(root, ".context-room/workflow-state.json", state);
    write(root, `${base}/journal.json`, { status: "complete", plan: current, state });
    return { ...state, migrated: true, idempotent: false };
  });
}
