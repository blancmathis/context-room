import fs from 'node:fs';
import { notebookImageSize } from './notebook_images.mjs';
import { randomUUID } from 'node:crypto';
import { NOTEBOOK_VERSION, NOTEBOOK_LIMITS, notebookId, notebookPath, notebookActor, failNotebook, emptyNotebook, normalizeNotebookDocument, applyNotebookEdits, cloneNotebook } from './notebook_protocol.mjs';
import { notebookHash, stableNotebookJson, canonicalNotebookRoot, safeNotebookPath, makeNotebookDirectory, readNotebookBytes, writeNotebookBytes, readNotebookJson, writeNotebookJson, withNotebookLock } from './notebook_io.mjs';

export const NOTEBOOK_STORE = '.context-room/notebooks/v1';
const resourcePath = id => `${NOTEBOOK_STORE}/resources/${notebookId(id)}`;
const eventPattern = /^(\d{16})-([a-f0-9]{64})\.json$/;
const maxFrameBytes = 64 * 1024 * 1024;
function validateImage(asset) {
  const bytes = Buffer.from(asset.data, 'base64');
  const valid = asset.mimeType === 'image/png' ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : asset.mimeType === 'image/jpeg' ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : asset.mimeType === 'image/webp' ? bytes.length >= 16 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' : false;
  if (!valid || bytes.toString('base64') !== asset.data) failNotebook('notebook_asset', 'The embedded raster image does not match its declared format.');
  notebookImageSize(bytes, asset.mimeType);
  return bytes;
}
export function encodeNotebook(input) {
  const document = normalizeNotebookDocument(input);
  for (const [hash, asset] of Object.entries(document.assets)) if (notebookHash(validateImage(asset)) !== hash) failNotebook('notebook_asset', 'Embedded image bytes do not match their content address.');
  const bytes = Buffer.from(stableNotebookJson(document) + '\n');
  if (bytes.length > NOTEBOOK_LIMITS.bytes) failNotebook('notebook_size', 'The notebook exceeds 20 MiB. No source was replaced.');
  return bytes;
}
export function decodeNotebook(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > NOTEBOOK_LIMITS.bytes || !bytes.equals(Buffer.from(bytes.toString('utf8')))) failNotebook('notebook_format', 'Notebook source must be bounded UTF-8.');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { failNotebook('notebook_format', 'The notebook source is invalid. Preserve it for explicit recovery.'); }
  const document = normalizeNotebookDocument(value); encodeNotebook(document); return document;
}
function readFrame(root, rel) {
  const bytes = readNotebookBytes(root, rel, maxFrameBytes);
  if (!bytes) failNotebook('notebook_recovery_conflict', 'A notebook history frame is missing.');
  try { return JSON.parse(bytes.toString('utf8')); } catch { failNotebook('notebook_recovery_conflict', 'A notebook history frame is damaged; retain the original for recovery.'); }
}
function applyFrame(state, frame, file) {
  const { hash, ...unsigned } = frame;
  if (frame.schemaVersion !== 1 || frame.resourceId !== state.document.id || frame.sequence !== state.sequence + 1 || frame.previous !== state.chain || hash !== notebookHash(unsigned)) failNotebook('notebook_recovery_conflict', 'Notebook history integrity failed. Preserve the original history before recovery.');
  notebookId(frame.operationId); notebookActor(frame.actor);
  if (state.receipts.has(frame.operationId)) failNotebook('notebook_recovery_conflict', 'A notebook history contains a duplicate operation.');
  if (frame.kind === 'edits') {
    const objects = new Map(state.document.objects.map(o => [o.id, o]));
    for (const change of frame.changes) { if (change.after) objects.set(change.id, change.after); else objects.delete(change.id); state.tombstones[change.id] = change.revision; if (change.after && !state.origins[change.id]) state.origins[change.id] = change.after.createdBy; }
    state.document = { ...state.document, revision: frame.sceneRevision, objects: [...objects.values()] };
  } else if (frame.kind === 'asset') {
    state.document.assets[frame.assetId] = frame.asset; state.document.revision = frame.sceneRevision;
  } else if (frame.kind === 'freeze') state.frozen.set(frame.operationId, frame.snapshot);
  else if (frame.kind === 'submit') {
    state.submissions.set(frame.operationId, frame.submission);
    state.knownSources.add(frame.submission.sourceHash);
  } else if (frame.kind === 'relocate') state.locator = frame.locator;
  else failNotebook('notebook_recovery_conflict', 'Unknown notebook history operation.');
  state.sequence = frame.sequence; state.chain = hash;
  state.receipts.set(frame.operationId, { file, actor: frame.actor, fingerprint: frame.fingerprint, receipt: frame.receipt });
  state.history.push({ sequence: frame.sequence, kind: frame.kind, operationId: frame.operationId, actor: frame.actor, at: frame.receipt.at, objectIds: (frame.changes || []).map(c => c.id) });
}
function readState(root, id) {
  const rootIdentity = canonicalNotebookRoot(root), folder = resourcePath(id), header = readNotebookJson(root, `${folder}/header.json`);
  if (!header || header.schemaVersion !== 1 || header.document.id !== id) failNotebook('notebook_missing', 'Notebook working scene not found.');
  if (header.rootIdentity !== rootIdentity) failNotebook('notebook_root_conflict', 'This working scene belongs to another exact filesystem location.');
  const state = { document: decodeNotebook(Buffer.from(JSON.stringify(header.document))), locator: header.locator, rootIdentity, sequence: 0,
    chain: notebookHash(header), tombstones: {}, origins: Object.fromEntries(header.document.objects.map(o => [o.id, o.createdBy])), receipts: new Map(), frozen: new Map(), submissions: new Map(), knownSources: new Set([header.locator.sourceHash]), history: [] };
  const directory = safeNotebookPath(root, `${folder}/events`);
  const files = fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  for (const file of files) {
    if (file.startsWith('.') && file.endsWith('.tmp')) continue; // Unpublished, unacknowledged bytes are never treated as operations.
    const match = eventPattern.exec(file);
    if (!match) failNotebook('notebook_recovery_conflict', 'An unknown history file needs explicit recovery.');
    const rel = `${folder}/events/${file}`, frame = readFrame(root, rel);
    if (frame.hash !== match[2] || frame.sequence !== Number(match[1])) failNotebook('notebook_recovery_conflict', 'A history frame no longer matches its immutable address.');
    applyFrame(state, frame, rel);
  }
  return state;
}
function publishFrame(root, state, data) {
  const frame = { schemaVersion: 1, resourceId: state.document.id, sequence: state.sequence + 1, previous: state.chain, ...data };
  frame.hash = notebookHash(frame);
  const rel = `${resourcePath(state.document.id)}/events/${String(frame.sequence).padStart(16, '0')}-${frame.hash}.json`;
  const bytes = Buffer.from(stableNotebookJson(frame) + '\n');
  if (bytes.length > maxFrameBytes) failNotebook('notebook_size', 'This operation exceeds the history frame limit. Split the edit without discarding it.');
  writeNotebookBytes(root, rel, bytes, { exclusive: true });
  applyFrame(state, frame, rel);
  return cloneNotebook(frame.receipt);
}
function replay(state, operationId, fingerprint, actor) {
  const previous = state.receipts.get(operationId);
  if (!previous) return null;
  if (previous.fingerprint !== fingerprint || notebookHash(previous.actor) !== notebookHash(actor)) failNotebook('notebook_replay_conflict', 'An operation identifier cannot be reused for a different author or payload.');
  return { ...cloneNotebook(previous.receipt), replayed: true };
}
function assertLocation(root, state, expectedRevision) {
  if (!expectedRevision || expectedRevision !== state.locator.revision) failNotebook('notebook_location_stale', 'The notebook moved. Reopen its exact location; pending edits are retained.');
  const current = readNotebookBytes(root, state.locator.path, NOTEBOOK_LIMITS.bytes), sourceHash = current ? notebookHash(current) : null;
  if (!state.knownSources.has(sourceHash)) failNotebook('notebook_external_conflict', 'The ordinary file changed outside this working scene. Compare or export the retained draft before reconciling.', { expectedSourceHash: state.locator.sourceHash, actualSourceHash: sourceHash });
}
function requireWrite(state, canWrite) { if (!canWrite(state.locator.path)) failNotebook('notebook_path_scope', 'Notebook write permission is unavailable for this exact location.'); }
function publicState(state, { since = 0, includeDocument = true } = {}) {
  return { protocolVersion: NOTEBOOK_VERSION, resourceId: state.document.id, locator: cloneNotebook(state.locator), revision: state.document.revision, sequence: state.sequence,
    ...(includeDocument ? { document: cloneNotebook(state.document), tombstones: { ...state.tombstones } } : {}),
    history: cloneNotebook(state.history.filter(e => e.sequence > since).slice(0, 200)),
    historyComplete: state.history.filter(e => e.sequence > since).length <= 200,
    nextSequence: state.history.filter(e => e.sequence > since).slice(0, 200).at(-1)?.sequence || since,
    submissions: cloneNotebook([...state.submissions.values()].slice(-50)), status: 'confirmed', accepted: false };
}
export function openNotebook(root, { path, title = 'Notebook', id = randomUUID(), canWrite = () => false } = {}) {
  canonicalNotebookRoot(root); path = notebookPath(path); notebookId(id);
  if (!canWrite(path)) failNotebook('notebook_path_scope', 'This folder has not been authorized for notebooks.');
  return withNotebookLock(root, `${NOTEBOOK_STORE}/registry.lock`, () => {
    for (const entry of listNotebooks(root)) if (entry.path === path) return readNotebook(root, entry.id);
    const source = readNotebookBytes(root, path, NOTEBOOK_LIMITS.bytes), document = source ? decodeNotebook(source) : emptyNotebook(id, title);
    if (readNotebookJson(root, `${resourcePath(document.id)}/header.json`)) failNotebook('notebook_location_conflict', 'This notebook identity is attached elsewhere. Relocate it explicitly or import a separate copy.');
    const rootIdentity = canonicalNotebookRoot(root), sourceHash = source ? notebookHash(source) : null;
    const locator = { path, sourceHash, revision: notebookHash({ rootIdentity, path, id: document.id, sourceHash }) };
    writeNotebookJson(root, `${resourcePath(document.id)}/header.json`, { schemaVersion: 1, rootIdentity, locator, document }, { exclusive: true });
    return readNotebook(root, document.id);
  });
}
export function listNotebooks(root) {
  canonicalNotebookRoot(root); const directory = safeNotebookPath(root, `${NOTEBOOK_STORE}/resources`);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).sort().filter(id => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id)).flatMap(id => {
    if (!readNotebookJson(root, `${resourcePath(id)}/header.json`)) return [];
    const state = readState(root, id);
    return [{ id, title: state.document.title, path: state.locator.path, revision: state.document.revision, locationRevision: state.locator.revision, pending: true }];
  });
}
export function readNotebook(root, id, options) { return publicState(readState(root, notebookId(id)), options); }
export function notebookReceipt(root, id, operationId) {
  const previous = readState(root, notebookId(id)).receipts.get(notebookId(operationId));
  return previous ? cloneNotebook(previous.receipt) : { operationId, resourceId: id, status: 'unknown' };
}
export function mutateNotebook(root, request, { actor, canWrite = () => false } = {}) {
  const { resourceId: id, operationId, locationRevision, edits } = request;
  notebookId(id); notebookId(operationId); actor = notebookActor(actor);
  if (request.protocolVersion !== NOTEBOOK_VERSION) failNotebook('notebook_version', 'The client protocol is incompatible.');
  const fingerprint = notebookHash(request);
  return withNotebookLock(root, `${resourcePath(id)}/mutation.lock`, () => {
    const state = readState(root, id); requireWrite(state, canWrite);
    const previous = replay(state, operationId, fingerprint, actor); if (previous) return previous;
    assertLocation(root, state, locationRevision);
    const result = applyNotebookEdits(state.document, state.tombstones, edits, actor, { origins: state.origins }); encodeNotebook(result.document);
    const receipt = { protocolVersion: NOTEBOOK_VERSION, operationId, resourceId: id, revision: result.document.revision, sequence: state.sequence + 1,
      objectRevisions: Object.fromEntries(result.changes.map(c => [c.id, c.revision])), status: 'confirmed', accepted: false, at: new Date().toISOString() };
    return publishFrame(root, state, { kind: 'edits', operationId, fingerprint, actor, sceneRevision: result.document.revision, changes: result.changes, receipt });
  });
}
export function undoNotebook(root, { resourceId, operationId, undoOf, locationRevision }, { actor, canWrite = () => false } = {}) {
  actor = notebookActor(actor);
  const state = readState(root, notebookId(resourceId)); requireWrite(state, canWrite);
  const prior = state.receipts.get(notebookId(undoOf));
  if (!prior || notebookHash(prior.actor) !== notebookHash(actor)) failNotebook('notebook_authority', 'Undo only an operation by this author.');
  const frame = readFrame(root, prior.file);
  if (frame.kind !== 'edits') failNotebook('notebook_undo', 'This operation is not an editable gesture.');
  const edits = frame.changes.map(c => c.before ? { id: c.id, kind: 'put', expectedRevision: c.revision, object: c.before } : { id: c.id, kind: 'delete', expectedRevision: c.revision });
  return mutateNotebook(root, { protocolVersion: NOTEBOOK_VERSION, resourceId, operationId, locationRevision, edits, undoOf }, { actor, canWrite });
}
export function addNotebookAsset(root, request, { actor, canWrite = () => false } = {}) {
  const { resourceId: id, operationId, locationRevision, mimeType, data } = request;
  notebookId(id); notebookId(operationId); actor = notebookActor(actor);
  if (typeof data !== 'string' || data.length > NOTEBOOK_LIMITS.bytes) failNotebook('notebook_asset', 'Use a bounded raster image.');
  const asset = { mimeType, data }, assetId = notebookHash(validateImage(asset)), fingerprint = notebookHash(request);
  return withNotebookLock(root, `${resourcePath(id)}/mutation.lock`, () => {
    const state = readState(root, id); requireWrite(state, canWrite);
    const previous = replay(state, operationId, fingerprint, actor); if (previous) return previous;
    assertLocation(root, state, locationRevision);
    const document = { ...state.document, revision: state.document.revision + 1, assets: { ...state.document.assets, [assetId]: asset } }; encodeNotebook(document);
    const receipt = { protocolVersion: NOTEBOOK_VERSION, operationId, resourceId: id, assetId, revision: document.revision, sequence: state.sequence + 1, status: 'confirmed', accepted: false, at: new Date().toISOString() };
    return publishFrame(root, state, { kind: 'asset', operationId, fingerprint, actor, sceneRevision: document.revision, assetId, asset, receipt });
  });
}
/** A frozen document includes exactly these objects and embedded resources, never later gestures. */
export function freezeNotebook(root, request, { actor, canWrite = () => false } = {}) {
  const { resourceId: id, operationId, expectedRevision, locationRevision } = request;
  notebookId(id); notebookId(operationId); actor = notebookActor(actor); const fingerprint = notebookHash(request);
  return withNotebookLock(root, `${resourcePath(id)}/mutation.lock`, () => {
    const state = readState(root, id); requireWrite(state, canWrite);
    const previous = replay(state, operationId, fingerprint, actor); if (previous) return previous;
    assertLocation(root, state, locationRevision);
    if (expectedRevision !== state.document.revision) failNotebook('notebook_scene_stale', 'The scene changed before submission. Inspect the new revision first.');
    const bytes = encodeNotebook(state.document), sourceHash = notebookHash(bytes), rel = `${resourcePath(id)}/snapshots/${sourceHash}.crnb`;
    const existing = readNotebookBytes(root, rel, NOTEBOOK_LIMITS.bytes);
    if (existing && !existing.equals(bytes)) failNotebook('notebook_recovery_conflict', 'A frozen notebook object is damaged.');
    if (!existing) writeNotebookBytes(root, rel, bytes, { exclusive: true });
    const snapshot = { freezeId: operationId, resourceId: id, sourceHash, sceneRevision: expectedRevision, path: state.locator.path, locationRevision, historySequence: state.sequence };
    const receipt = { protocolVersion: NOTEBOOK_VERSION, operationId, ...snapshot, status: 'frozen', accepted: false, at: new Date().toISOString() };
    return publishFrame(root, state, { kind: 'freeze', operationId, fingerprint, actor, snapshot, receipt });
  });
}
export function readFrozenNotebook(root, id, freezeId) {
  const state = readState(root, notebookId(id)), snapshot = state.frozen.get(notebookId(freezeId));
  if (!snapshot) failNotebook('notebook_snapshot_missing', 'Frozen notebook version not found.');
  const bytes = readNotebookBytes(root, `${resourcePath(id)}/snapshots/${snapshot.sourceHash}.crnb`, NOTEBOOK_LIMITS.bytes);
  if (!bytes || notebookHash(bytes) !== snapshot.sourceHash) failNotebook('notebook_recovery_conflict', 'The frozen document is missing or damaged.');
  return { ...cloneNotebook(snapshot), bytes, document: decodeNotebook(bytes) };
}
/** Internal adapter callback after the existing proposal engine has returned its exact submission. */
export function recordNotebookSubmission(root, request, { actor, canWrite = () => false, verifyProposal } = {}) {
  const { resourceId: id, operationId, freezeId, proposalId, proposalRevision } = request;
  notebookId(id); notebookId(operationId); actor = notebookActor(actor); const fingerprint = notebookHash(request);
  if (typeof verifyProposal !== 'function') failNotebook('notebook_authority', 'The canonical proposal adapter must verify a submission.');
  return withNotebookLock(root, `${resourcePath(id)}/mutation.lock`, () => {
    const state = readState(root, id); requireWrite(state, canWrite);
    const previous = replay(state, operationId, fingerprint, actor); if (previous) return previous;
    const snapshot = readFrozenNotebook(root, id, freezeId);
    if (snapshot.locationRevision !== state.locator.revision) failNotebook('notebook_location_stale', 'The notebook moved after it was frozen.');
    if (verifyProposal({ proposalId, proposalRevision, path: snapshot.path, sourceHash: snapshot.sourceHash }) !== true) failNotebook('notebook_submission_conflict', 'The canonical proposal does not contain this exact frozen document.');
    const submission = { freezeId, proposalId, proposalRevision, sourceHash: snapshot.sourceHash, sceneRevision: snapshot.sceneRevision, path: snapshot.path,
      ...(request.scope === 'shared' ? { scope: 'shared', target: request.target } : {}) };
    const receipt = { protocolVersion: NOTEBOOK_VERSION, operationId, resourceId: id, ...submission, status: 'submitted', accepted: false, at: new Date().toISOString() };
    return publishFrame(root, state, { kind: 'submit', operationId, fingerprint, actor, submission, receipt });
  });
}
/** Rebind a draft after the ordinary file mover has preserved its bytes, or move a not-yet-published draft. */
export function relocateNotebook(root, request, { actor, canWrite = () => false } = {}) {
  const { resourceId: id, operationId, locationRevision, path: nextPath } = request;
  notebookId(id); notebookId(operationId); notebookPath(nextPath); actor = notebookActor(actor); const fingerprint = notebookHash(request);
  return withNotebookLock(root, `${NOTEBOOK_STORE}/registry.lock`, () => withNotebookLock(root, `${resourcePath(id)}/mutation.lock`, () => {
    const state = readState(root, id); requireWrite(state, canWrite);
    if (!canWrite(nextPath)) failNotebook('notebook_path_scope', 'The destination has not been authorized.');
    const previous = replay(state, operationId, fingerprint, actor); if (previous) return previous;
    if (locationRevision !== state.locator.revision) failNotebook('notebook_location_stale', 'The notebook location changed.');
    if (listNotebooks(root).some(n => n.id !== id && n.path === nextPath)) failNotebook('notebook_location_conflict', 'Another working notebook occupies that destination.');
    const old = readNotebookBytes(root, state.locator.path, NOTEBOOK_LIMITS.bytes), next = readNotebookBytes(root, nextPath, NOTEBOOK_LIMITS.bytes);
    if (old && nextPath !== state.locator.path) failNotebook('notebook_location_conflict', 'Move the ordinary file with Context Room before rebinding its retained working history.');
    const sourceHash = next ? notebookHash(next) : null;
    if (!state.knownSources.has(sourceHash)) failNotebook('notebook_location_conflict', 'The destination contains different bytes. Nothing was overwritten.');
    const locator = { path: nextPath, sourceHash, revision: notebookHash({ previous: locationRevision, path: nextPath, operationId }) };
    const receipt = { protocolVersion: NOTEBOOK_VERSION, operationId, resourceId: id, locationRevision: locator.revision, path: nextPath, status: 'confirmed', accepted: false, at: new Date().toISOString() };
    return publishFrame(root, state, { kind: 'relocate', operationId, fingerprint, actor, locator, receipt });
  }));
}
