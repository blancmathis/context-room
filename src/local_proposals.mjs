import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withFilesystemLock } from "./filesystem_lock.mjs";

const STORE = ".context-room/local-proposals";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const revision = (value) => hash(JSON.stringify(value));
const identity = (stats) => `${stats.dev}:${stats.ino}`;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = code.includes("conflict") || code.includes("stale") ? 409 : 400;
  throw error;
}

function relative(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("local_proposal_path", "A canonical relative file path is required.");
  }
  return value;
}

// Follow neither a replaced directory nor a symlink when writing documents or control files.
// Explorer navigation can still resolve legitimate links; proposal writes need a concrete target.
function safePath(root, rel) {
  relative(rel);
  let current = root;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    let stats;
    try { stats = fs.lstatSync(current); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
      fail("local_proposal_path", `Unsafe filesystem entry: ${rel}`);
    }
  }
  return current;
}

function readBytes(root, rel) {
  const target = safePath(root, rel);
  let fd;
  try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) fail("local_proposal_path", `Expected a regular file: ${rel}`);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (identity(before) !== identity(after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || identity(fs.lstatSync(safePath(root, rel))) !== identity(after)) {
      fail("local_proposal_conflict", `File changed while reading: ${rel}`);
    }
    return { bytes, hash: hash(bytes), mode: after.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}

function atomicWrite(root, rel, bytes, mode = 0o600) {
  const target = safePath(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tempRel = `${rel}.${randomUUID()}.tmp`;
  const temp = safePath(root, tempRel);
  const fd = fs.openSync(temp, "wx", mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    safePath(root, rel);
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function readJson(root, rel) {
  const file = readBytes(root, rel);
  return file ? JSON.parse(file.bytes.toString("utf8")) : null;
}

function writeJson(root, rel, value) {
  atomicWrite(root, rel, JSON.stringify(value, null, 2) + "\n");
}

function context(projectRoot, { create = false } = {}) {
  const root = fs.realpathSync(projectRoot);
  const rootIdentity = identity(fs.statSync(root));
  const store = safePath(root, STORE);
  if (create) fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  return { root, rootIdentity, store };
}

function locked(projectRoot, operation, recoveryId = null) {
  const ctx = context(projectRoot, { create: true });
  return withFilesystemLock(path.join(ctx.store, "mutation.lock"), () => {
    if (identity(fs.statSync(ctx.root)) !== ctx.rootIdentity) fail("local_proposal_conflict", "The project directory changed.");
    safePath(ctx.root, STORE);
    const journals = safePath(ctx.root, `${STORE}/journal`);
    for (const name of fs.existsSync(journals) ? fs.readdirSync(journals) : []) {
      if (!name.endsWith(".json") || name === `${recoveryId}.json`) continue;
      if (readJson(ctx.root, `${STORE}/journal/${name}`)?.status === "applying") {
        fail("local_proposal_recovery_conflict", `An interrupted review must be recovered first: ${name.slice(0, -5)}`);
      }
    }
    return operation(ctx);
  });
}

function proposalPath(id) {
  if (!/^local-[0-9a-f-]{36}$/.test(id || "")) fail("local_proposal_id", "Invalid local proposal id.");
  return `${STORE}/proposals/${id}.json`;
}

function readProposal(ctx, id) {
  const proposal = readJson(ctx.root, proposalPath(id));
  if (!proposal || proposal.schemaVersion !== 1 || proposal.id !== id) fail("local_proposal_missing", "Local proposal not found.");
  if (proposal.rootIdentity !== ctx.rootIdentity) fail("local_proposal_conflict", "The original project directory was replaced.");
  if (proposal.baseRevision !== manifestRevision(proposal.base)
    || (proposal.submitted && proposal.submittedRevision !== submissionRevision(proposal, proposal.submitted))) {
    fail("local_proposal_corrupt", "The proposal manifest no longer matches its recorded revision.");
  }
  return proposal;
}

function saveProposal(ctx, proposal) {
  writeJson(ctx.root, proposalPath(proposal.id), proposal);
}

function blobPath(digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || "")) fail("local_proposal_blob", "Invalid content address.");
  return `${STORE}/objects/${digest.slice(0, 2)}/${digest}`;
}

function storeBlob(ctx, bytes) {
  const digest = hash(bytes);
  const rel = blobPath(digest);
  const existing = readBytes(ctx.root, rel);
  if (existing && existing.hash !== digest) fail("local_proposal_corrupt", "A stored content object is damaged.");
  if (!existing) atomicWrite(ctx.root, rel, bytes);
  return digest;
}

function readBlob(ctx, digest) {
  const value = readBytes(ctx.root, blobPath(digest));
  if (!value || value.hash !== digest) fail("local_proposal_corrupt", "A stored content object is missing or damaged.");
  return value.bytes;
}

function inScope(rel, allowedPaths) {
  return !rel.split("/").some((part) => part === ".git" || part === ".context-room")
    && allowedPaths.some((entry) => entry.endsWith("/") ? rel.startsWith(entry) : rel === entry);
}

function manifestRevision(manifest) {
  return revision(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b, "en")));
}

function submissionRevision(proposal, submitted) {
  return revision({ id: proposal.id, rootIdentity: proposal.rootIdentity, allowedPaths: proposal.allowedPaths,
    base: manifestRevision(proposal.base), submitted: manifestRevision(submitted) });
}

function workspaceManifest(ctx, proposal) {
  const workspace = safePath(ctx.root, proposal.workspace);
  const result = Object.create(null);
  function visit(folder = "") {
    for (const entry of fs.readdirSync(path.join(workspace, folder), { withFileTypes: true })) {
      const rel = folder ? `${folder}/${entry.name}` : entry.name;
      safePath(workspace, rel);
      if (entry.isDirectory()) visit(rel);
      else {
        if (!inScope(rel, proposal.allowedPaths)) fail("local_proposal_scope", `File outside the proposal scope: ${rel}`);
        const file = readBytes(workspace, rel);
        if (!file) fail("local_proposal_conflict", `File disappeared during submission: ${rel}`);
        result[rel] = { hash: storeBlob(ctx, file.bytes), mode: file.mode };
      }
    }
  }
  visit();
  return result;
}

function sameVersion(a, b) {
  return (a?.hash || null) === (b?.hash || null) && (a?.mode || null) === (b?.mode || null);
}

function changesFor(proposal) {
  if (!proposal.submitted) return [];
  return [...new Set([...Object.keys(proposal.base), ...Object.keys(proposal.submitted)])].sort()
    .filter((rel) => !sameVersion(proposal.base[rel], proposal.submitted[rel]))
    .map((rel) => ({ path: rel, kind: !proposal.base[rel] ? "added" : !proposal.submitted[rel] ? "deleted" : "modified",
      before: proposal.base[rel] || null, after: proposal.submitted[rel] || null,
      decision: proposal.decisions[rel] || null }));
}

function publicProposal(ctx, proposal) {
  return { ...proposal, root: ctx.root, editRoot: path.join(ctx.root, proposal.workspace), changes: changesFor(proposal) };
}

/** The caller supplies the accepted corpus, never an unchecked working-tree snapshot. */
export function beginLocalProposal(projectRoot, { title, description = "", files = [], allowedPaths = [] } = {}) {
  if (!String(title || "").trim()) fail("local_proposal_title", "A proposal title is required.");
  const scopes = allowedPaths.map((entry) => {
    relative(entry.endsWith("/") ? entry.slice(0, -1) : entry);
    return entry;
  });
  return locked(projectRoot, (ctx) => {
    const id = `local-${randomUUID()}`;
    const workspace = `${STORE}/workspaces/${id}`;
    fs.mkdirSync(safePath(ctx.root, workspace), { recursive: true, mode: 0o700 });
    const base = Object.create(null);
    for (const file of files) {
      const rel = relative(file.path);
      if (!inScope(rel, scopes)) fail("local_proposal_scope", `Accepted document outside proposal scope: ${rel}`);
      if (Object.hasOwn(base, rel)) fail("local_proposal_path", `Duplicate document: ${rel}`);
      const bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
      const digest = storeBlob(ctx, bytes);
      const mode = file.mode ?? 0o644;
      base[rel] = { hash: digest, mode };
      const destination = safePath(ctx.root, `${workspace}/${rel}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      // Reflink where supported; Node falls back to independent bytes. Never hardlink drafts.
      fs.copyFileSync(safePath(ctx.root, blobPath(digest)), destination, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, mode);
    }
    const now = new Date().toISOString();
    const proposal = { schemaVersion: 1, id, scope: "local", title: String(title).trim(), description,
      rootIdentity: ctx.rootIdentity, workspace, allowedPaths: scopes, base,
      baseRevision: manifestRevision(base), status: "editing", createdAt: now, updatedAt: now, decisions: {} };
    saveProposal(ctx, proposal);
    return publicProposal(ctx, proposal);
  });
}

export function listLocalProposals(projectRoot, { readyOnly = false } = {}) {
  const ctx = context(projectRoot);
  const folder = safePath(ctx.root, `${STORE}/proposals`);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => /^local-[0-9a-f-]{36}\.json$/.test(name))
    .map((name) => publicProposal(ctx, readProposal(ctx, name.slice(0, -5))))
    .filter((proposal) => !readyOnly || proposal.status === "submitted")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function inspectLocalProposal(projectRoot, id) {
  const ctx = context(projectRoot);
  return publicProposal(ctx, readProposal(ctx, id));
}

export function submitLocalProposal(projectRoot, id, { canWrite = () => true } = {}) {
  return locked(projectRoot, (ctx) => {
    const proposal = readProposal(ctx, id);
    if (["accepted", "rejected", "resolved"].includes(proposal.status) || Object.keys(proposal.decisions).length) {
      fail("local_proposal_closed", "A reviewed proposal cannot be resubmitted. Create a new proposal for further changes.");
    }
    const submitted = workspaceManifest(ctx, proposal);
    for (const entry of changesFor({ ...proposal, submitted })) {
      if (!canWrite(entry.path)) fail("local_proposal_scope", `This document is no longer editable in the proposal: ${entry.path}`);
    }
    if (manifestRevision(submitted) !== manifestRevision(workspaceManifest(ctx, proposal))) {
      fail("local_proposal_conflict", "The workspace changed during submission. Retry when edits are finished.");
    }
    proposal.submitted = submitted;
    proposal.submittedRevision = submissionRevision(proposal, submitted);
    proposal.status = "submitted";
    proposal.submittedAt = new Date().toISOString();
    proposal.updatedAt = proposal.submittedAt;
    saveProposal(ctx, proposal);
    return publicProposal(ctx, proposal);
  });
}

export function readLocalProposalFile(projectRoot, id, rel) {
  const ctx = context(projectRoot);
  const proposal = readProposal(ctx, id);
  const change = changesFor(proposal).find((entry) => entry.path === relative(rel));
  if (!change) fail("local_proposal_change", "This file has no submitted change.");
  return { ...change, proposalId: id, revision: proposal.submittedRevision,
    beforeBytes: change.before ? readBlob(ctx, change.before.hash) : null,
    afterBytes: change.after ? readBlob(ctx, change.after.hash) : null };
}

export function readLocalProposalResource(projectRoot, id, rel, { side = "after", expectedRevision } = {}) {
  const ctx = context(projectRoot), proposal = readProposal(ctx, id);
  if (expectedRevision !== proposal.submittedRevision || !["before", "after"].includes(side)) fail("local_proposal_stale", "The rendered document revision changed.");
  const file = (side === "before" ? proposal.base : proposal.submitted)?.[relative(rel)];
  if (!file) fail("local_proposal_change", "The resource is absent from this version.");
  return readBlob(ctx, file.hash);
}

function finalizeDecision(ctx, proposal, journal, onAccepted) {
  if (onAccepted) onAccepted({ path: journal.path, bytes: journal.after ? readBlob(ctx, journal.after.hash) : null,
    mode: journal.after?.mode || null, at: journal.at });
  const accepted = readJson(ctx.root, `${STORE}/accepted.json`) || { schemaVersion: 1, files: {} };
  if (journal.after) accepted.files[journal.path] = journal.after;
  else accepted.files[journal.path] = null;
  writeJson(ctx.root, `${STORE}/accepted.json`, accepted);
  proposal.decisions[journal.path] = { status: "accepted", revision: journal.revision, at: journal.at };
  updateStatus(proposal);
  saveProposal(ctx, proposal);
  writeJson(ctx.root, `${STORE}/journal/${proposal.id}.json`, { ...journal, status: "complete" });
}

function updateStatus(proposal) {
  const changes = changesFor(proposal);
  if (changes.length && changes.every((entry) => entry.decision)) {
    const states = new Set(changes.map((entry) => entry.decision.status));
    proposal.status = states.size > 1 ? "resolved" : states.has("accepted") ? "accepted" : "rejected";
  }
  proposal.updatedAt = new Date().toISOString();
}

function recover(ctx, proposal, onAccepted) {
  const rel = `${STORE}/journal/${proposal.id}.json`;
  const journal = readJson(ctx.root, rel);
  if (!journal || journal.status !== "applying") return;
  const current = readBytes(ctx.root, journal.path);
  if (sameVersion(current, journal.after)) finalizeDecision(ctx, proposal, journal, onAccepted);
  else if (sameVersion(current, journal.before)) writeJson(ctx.root, rel, { ...journal, status: "not-applied" });
  else if (!current && journal.claim && sameVersion(readBytes(ctx.root, journal.claim), journal.before)) {
    fs.copyFileSync(safePath(ctx.root, journal.claim), safePath(ctx.root, journal.path), fs.constants.COPYFILE_EXCL);
    writeJson(ctx.root, rel, { ...journal, status: "not-applied" });
  }
  else fail("local_proposal_recovery_conflict", `Application was interrupted and ${journal.path} changed. Both stored versions are preserved.`);
}

/** Human UI boundary only. No agent-facing decision command. */
export function decideLocalProposalFile(projectRoot, id, { path: rel, decision, expectedRevision, content } = {}, { canWrite = () => true, beforeApply, onAccepted } = {}) {
  return locked(projectRoot, (ctx) => {
    const proposal = readProposal(ctx, id);
    recover(ctx, proposal, onAccepted);
    if (!expectedRevision || expectedRevision !== proposal.submittedRevision) fail("local_proposal_stale", "The submitted proposal changed. Reload its review.");
    const change = changesFor(proposal).find((entry) => entry.path === relative(rel));
    if (!change) fail("local_proposal_change", "This file has no submitted change.");
    if (!["accepted", "rejected"].includes(decision)) fail("local_proposal_decision", "Choose accept or reject.");
    if (decision === "accepted" && !canWrite(rel)) fail("local_proposal_scope", `This document is no longer editable in the proposal: ${rel}`);
    if (change.decision) {
      if (change.decision.status === decision && content === undefined) return publicProposal(ctx, proposal);
      fail("local_proposal_closed", "This file already has a decision.");
    }
    if (submissionRevision(proposal, workspaceManifest(ctx, proposal)) !== proposal.submittedRevision) {
      fail("local_proposal_stale", "The agent changed the workspace after submission. Submit and review the new version.");
    }
    if (decision === "rejected") {
      proposal.decisions[rel] = { status: decision, revision: expectedRevision, at: new Date().toISOString() };
      updateStatus(proposal);
      saveProposal(ctx, proposal);
      return publicProposal(ctx, proposal);
    }
    const current = readBytes(ctx.root, rel);
    if (!sameVersion(current, change.before)) fail("local_proposal_conflict", `The original ${rel} changed. No file was overwritten.`);
    const after = content === undefined ? change.after : { hash: storeBlob(ctx, Buffer.from(content)), mode: change.after?.mode || change.before?.mode || 0o644 };
    if (beforeApply) beforeApply({ path: rel, bytes: after ? readBlob(ctx, after.hash) : null, mode: after?.mode || null });
    const claim = change.before ? `${STORE}/recovery/${randomUUID()}` : null;
    const journal = { status: "applying", path: rel, before: change.before, after, claim,
      revision: expectedRevision, at: new Date().toISOString() };
    writeJson(ctx.root, `${STORE}/journal/${proposal.id}.json`, journal);
    // Recheck after preparing recovery evidence and immediately before touching the source.
    if (!sameVersion(readBytes(ctx.root, rel), change.before)) fail("local_proposal_conflict", `The original ${rel} changed before application.`);
    if (claim) {
      fs.mkdirSync(path.dirname(safePath(ctx.root, claim)), { recursive: true, mode: 0o700 });
      fs.renameSync(safePath(ctx.root, rel), safePath(ctx.root, claim));
      if (!sameVersion(readBytes(ctx.root, claim), change.before)) {
        if (!readBytes(ctx.root, rel)) fs.copyFileSync(safePath(ctx.root, claim), safePath(ctx.root, rel), fs.constants.COPYFILE_EXCL);
        fail("local_proposal_conflict", `A concurrent edit was preserved in ${claim}. Reload the review.`);
      }
    }
    if (after) {
      const temporary = `${STORE}/recovery/${randomUUID()}.new`;
      atomicWrite(ctx.root, temporary, readBlob(ctx, after.hash), after.mode);
      fs.mkdirSync(path.dirname(safePath(ctx.root, rel)), { recursive: true, mode: 0o700 });
      // A destination created after the claim wins. Never replace a newer writer.
      try { fs.linkSync(safePath(ctx.root, temporary), safePath(ctx.root, rel)); }
      finally { fs.unlinkSync(safePath(ctx.root, temporary)); }
    }
    finalizeDecision(ctx, proposal, journal, onAccepted);
    return publicProposal(ctx, proposal);
  }, id);
}

export function readAcceptedLocalProposalFile(projectRoot, rel) {
  const ctx = context(projectRoot);
  const accepted = readJson(ctx.root, `${STORE}/accepted.json`);
  if (!accepted || !Object.hasOwn(accepted.files, relative(rel))) return undefined;
  const version = accepted.files[rel];
  return version ? { ...version, bytes: readBlob(ctx, version.hash) } : null;
}
