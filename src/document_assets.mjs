import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withFilesystemLock } from "./filesystem_lock.mjs";
import { authorizeOwnerTrustedState, inspectOwnerTrustedState } from "./review_authority.mjs";
import { beginLocalProposal, submitLocalProposal, decideLocalProposalFile } from "./local_proposals.mjs";

const STORE = ".context-room/document-assets";
const MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_ASSET_FORMATS = new Map([
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"],
  ["webp", "image/webp"], ["avif", "image/avif"], ["svg", "image/svg+xml"], ["pdf", "application/pdf"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const revision = (value) => hash(JSON.stringify(value));
const fail = (message) => { const error = new Error(message); error.code = "asset_revision_conflict"; error.statusCode = 409; throw error; };
export const isDocumentAssetPath = (rel) => DOCUMENT_ASSET_FORMATS.has(path.extname(String(rel)).slice(1).toLowerCase());

function safe(root, rel) {
  if (!rel || path.isAbsolute(rel) || rel.includes("\\") || rel.includes("\0") || rel.split("/").some((part) => !part || part === "." || part === "..")) fail("A canonical relative document path is required.");
  let target = fs.realpathSync(root);
  for (const part of rel.split("/")) {
    target = path.join(target, part);
    try { if (fs.lstatSync(target).isSymbolicLink()) fail(`Symbolic links cannot be mutated: ${rel}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return target;
}
function read(root, rel) {
  let fd;
  try { fd = fs.openSync(safe(root, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES) fail(`The asset must be a regular file of at most 20 MiB: ${rel}`);
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), visible = fs.lstatSync(safe(root, rel));
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size || after.ino !== visible.ino || after.dev !== visible.dev) fail(`The asset changed during reading: ${rel}`);
    return { bytes, hash: hash(bytes), mode: after.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
function json(root, rel, fallback = null) { const file = read(root, rel); return file ? JSON.parse(file.bytes.toString()) : fallback; }
function write(root, rel, bytes) {
  const target = safe(root, rel); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`, fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, safe(root, rel)); } finally { fs.rmSync(temp, { force: true }); }
}
function ledger(root) {
  const state = json(root, `${STORE}/accepted.json`, {});
  if (Object.keys(state).length && !inspectOwnerTrustedState(root, "document-assets", state, { readOnly: true }).trusted) fail("Accepted asset history lost its human authority. Restore or review it explicitly.");
  return state;
}
function base(root, state, rel) {
  const version = state[rel]; if (!version) return null;
  if (!/^[a-f0-9]{64}$/.test(version.hash)) fail("Invalid accepted asset address.");
  const file = read(root, `${STORE}/objects/${version.hash}`);
  if (!file || file.hash !== version.hash) fail("An accepted asset object is missing or damaged.");
  return { ...version, bytes: file.bytes, absolutePath: safe(root, `${STORE}/objects/${version.hash}`) };
}
function inScope(rel, scopes) { return !rel.split("/").some((part) => part.startsWith(".") || part === "node_modules") && scopes.some((scope) => rel === scope || rel.startsWith(scope.replace(/\/$/, "") + "/")); }

export function listDocumentAssets(root, { allowedPaths = [], canRead = () => true, acceptedOnly = false } = {}) {
  const state = ledger(root), paths = new Set(Object.keys(state));
  const visit = (rel) => {
    let entry; try { entry = fs.lstatSync(safe(root, rel)); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (entry.isDirectory()) {
      for (const child of fs.readdirSync(safe(root, rel), { withFileTypes: true })) {
        if (child.name.startsWith(".") || child.name === "node_modules" || child.isSymbolicLink()) continue;
        visit(`${rel}/${child.name}`);
      }
    } else if (entry.isFile() && isDocumentAssetPath(rel)) paths.add(rel);
  };
  if (!acceptedOnly) for (const scope of allowedPaths) { const rel = scope.replace(/\/$/, ""); if (rel && !rel.startsWith("~") && !path.isAbsolute(rel)) visit(rel); }
  return [...paths].filter((rel) => inScope(rel, allowedPaths) && canRead(rel)).sort().map((rel) => acceptedOnly ? { path: rel, mimeType: DOCUMENT_ASSET_FORMATS.get(path.extname(rel).slice(1).toLowerCase()), before: base(root, state, rel) } : readDocumentAssetReview(root, rel, state));
}

export function readDocumentAssetReview(root, rel, state = ledger(root)) {
  if (!isDocumentAssetPath(rel)) fail("Unsupported asset format.");
  const before = base(root, state, rel), after = read(root, rel);
  const descriptor = (file) => file ? { hash: file.hash, mode: file.mode } : null;
  return { path: rel, mimeType: DOCUMENT_ASSET_FORMATS.get(path.extname(rel).slice(1).toLowerCase()),
    before, after, revision: revision([rel, descriptor(before), descriptor(after)]),
    kind: !before ? "added" : !after ? "deleted" : "modified", pending: revision(descriptor(before)) !== revision(descriptor(after)) };
}

export function recordAcceptedDocumentAsset(root, rel, bytes, mode = 0o644) {
  if (!isDocumentAssetPath(rel)) fail("Unsupported asset format.");
  const state = ledger(root);
  if (bytes !== null) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) fail("Invalid or oversized asset bytes.");
    const digest = hash(bytes); write(root, `${STORE}/objects/${digest}`, bytes);
    state[rel] = { hash: digest, mode, at: new Date().toISOString() };
  } else state[rel] = null;
  authorizeOwnerTrustedState(root, "document-assets", state);
  write(root, `${STORE}/accepted.json`, JSON.stringify(state));
  return { accepted: true, path: rel, contentHash: state[rel]?.hash || null };
}

/** Direct human review or a previously authorized cleanup. Never an agent CLI command. */
export function decideDocumentAsset(root, rel, { decision, expectedRevision, bytes, canWrite = () => true, beforeApply } = {}) {
  if (!["accepted", "rejected"].includes(decision) || !canWrite(rel)) fail("This asset cannot receive this decision.");
  fs.mkdirSync(safe(root, STORE), { recursive: true, mode: 0o700 });
  return withFilesystemLock(safe(root, `${STORE}/review.lock`), () => {
    const journalPath = `${STORE}/operations/${revision(rel)}.json`;
    let operation = json(root, journalPath);
    const inputDigest = bytes === undefined ? null : hash(bytes);
    if (operation?.status !== "applying") {
      const file = readDocumentAssetReview(root, rel);
      if (!expectedRevision || file.revision !== expectedRevision) fail("The asset changed. Reload its review.");
      const desired = decision === "rejected" ? file.before?.bytes ?? null : bytes ?? file.after?.bytes ?? null;
      const mode = (decision === "rejected" ? file.before : file.after)?.mode || 0o644;
      if (beforeApply) beforeApply({ path: rel, bytes: desired, mode });
      if (desired === null && file.after === null || desired && file.after && hash(desired) === file.after.hash) {
        return { ...recordAcceptedDocumentAsset(root, rel, desired, mode), rejected: decision === "rejected" };
      }
      const proposal = beginLocalProposal(root, { title: `Asset review: ${rel}`, files: file.after ? [{ path: rel, content: file.after.bytes, mode: file.after.mode }] : [], allowedPaths: [rel] });
      const target = safe(proposal.editRoot, rel);
      if (desired) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, desired); fs.chmodSync(target, mode); }
      else fs.unlinkSync(target);
      const submitted = submitLocalProposal(root, proposal.id);
      operation = { status: "applying", proposalId: proposal.id, submittedRevision: submitted.submittedRevision, expectedRevision, decision, inputDigest };
      write(root, journalPath, JSON.stringify(operation));
    }
    if (operation.expectedRevision !== expectedRevision || operation.decision !== decision || operation.inputDigest !== inputDigest) fail("Recover the interrupted asset decision before making a different decision.");
    decideLocalProposalFile(root, operation.proposalId, { path: rel, decision: "accepted", expectedRevision: operation.submittedRevision }, {
      canWrite, beforeApply, onAccepted: ({ bytes: acceptedBytes, mode }) => recordAcceptedDocumentAsset(root, rel, acceptedBytes, mode),
    });
    write(root, journalPath, JSON.stringify({ ...operation, status: "complete" }));
    return { accepted: decision === "accepted", rejected: decision === "rejected", path: rel, recoveryProposal: operation.proposalId };
  });
}
