import fs from 'node:fs';
import path from 'node:path';
import { notebookImageSize } from './notebook_images.mjs';
import { randomUUID } from 'node:crypto';
import { NOTEBOOK_VERSION, NOTEBOOK_LIMITS, notebookId, notebookPath, notebookActor, failNotebook, emptyNotebook, normalizeNotebookDocument, applyNotebookEdits, cloneNotebook } from './notebook_protocol.mjs';
import { notebookHash, stableNotebookJson, canonicalNotebookRoot, safeNotebookPath, makeNotebookDirectory, readNotebookBytes, writeNotebookBytes, readNotebookJson, writeNotebookJson, withNotebookLock, syncNotebookDirectory } from './notebook_io.mjs';
import { acceptsRootIdentity } from './location_attestation.mjs';

export const NOTEBOOK_STORE = '.context-room/notebooks/v1';
const resourcePath = id => `${NOTEBOOK_STORE}/resources/${notebookId(id)}`;
// Present only after a notebook left this root; its arrival elsewhere is verified first.
const movedPath = id => `${NOTEBOOK_STORE}/moved/${notebookId(id)}.json`;
/** Offline caches are keyed by this value; another root is another server. */
export const notebookServerId = (root, identity = canonicalNotebookRoot(root)) => notebookHash(['context-room-notebook-location-v1', root, identity]);
function assertNotMoved(root, id) {
  const moved = readNotebookJson(root, movedPath(id));
  if (moved) failNotebook('notebook_moved', 'This notebook moved to another place. Open it there; nothing was lost.', { destination: cloneNotebook(moved.to) });
}
// A moving copy waits here, invisible, until its source carries the moved marker of that exact move.
const incomingPath = (id, operationId) => `${NOTEBOOK_STORE}/incoming/${notebookId(id)}-${notebookId(operationId)}`;
/** The source marker is the single commit point of a move: before it the source is the
 * active copy, after it the staged copy is. Activation only finishes what was committed. */
function completeArrival(root, id, operationId) {
  const staged = safeNotebookPath(root, incomingPath(id, operationId)), stagedHeader = safeNotebookPath(root, `${incomingPath(id, operationId)}/header.json`);
  if (!fs.existsSync(staged)) return;
  if (fs.existsSync(stagedHeader)) {
    // A lock may have left the folder itself; only an existing header means another active copy.
    const active = makeNotebookDirectory(root, resourcePath(id)), activeHeader = safeNotebookPath(root, `${resourcePath(id)}/header.json`);
    if (!fs.existsSync(activeHeader)) {
      // An earlier departure from this root no longer applies once the notebook is back.
      fs.rmSync(safeNotebookPath(root, movedPath(id)), { force: true });
      try { fs.renameSync(stagedHeader, activeHeader); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      syncNotebookDirectory(active);
    }
    // Two readers, or a reader and the mover, may finish the same arrival: only another copy conflicts.
    if (readNotebookJson(root, `${resourcePath(id)}/header.json`)?.transferred?.operationId !== operationId) failNotebook('notebook_recovery_conflict', 'A moved notebook arrived where another copy is active. Both are kept; compare them.');
  }
  fs.rmSync(staged, { recursive: true, force: true }); syncNotebookDirectory(path.dirname(staged));
}
/** A staged copy is named exactly `${id}-${operationId}` by its own header. Ids may share a
 * prefix ("note", "note-2"), so a folder name alone never says which notebook it holds. */
function stagedArrival(root, name) {
  try {
    const staged = readNotebookJson(root, `${NOTEBOOK_STORE}/incoming/${name}/header.json`), operationId = staged?.transferred?.operationId;
    if (typeof operationId !== 'string' || name !== `${notebookId(staged.document?.id)}-${notebookId(operationId)}`) return null;
    return { id: staged.document.id, operationId, from: staged.transferred.from };
  } catch { return null; }
}
function committedArrival(root, name) {
  const arrival = stagedArrival(root, name), from = arrival?.from;
  if (typeof from?.root !== 'string') return null;
  try {
    if (canonicalNotebookRoot(from.root) !== from.rootIdentity || readNotebookJson(from.root, movedPath(arrival.id))?.operationId !== arrival.operationId) return null;
    return arrival;
  } catch { return null; } // A source that is unreadable or elsewhere commits nothing; the staged copy waits.
}
function activateArrivals(root, id) {
  const directory = safeNotebookPath(root, `${NOTEBOOK_STORE}/incoming`);
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory).sort()) {
    if (id ? !name.startsWith(`${id}-`) : name.startsWith('.')) continue;
    const arrival = committedArrival(root, name);
    if (!arrival || id && arrival.id !== id) continue;
    if (id) completeArrival(root, arrival.id, arrival.operationId);
    else try { completeArrival(root, arrival.id, arrival.operationId); } catch { /* reported when that notebook is read */ }
  }
}
const eventPattern = /^(\d{16})-([a-f0-9]{64})\.json$/;
const maxFrameBytes = 64 * 1024 * 1024;
function initialTombstones(document, value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > NOTEBOOK_LIMITS.objects) failNotebook('notebook_recovery_conflict', 'Invalid imported deletion index.');
  const live = new Set(document.objects.map(object => object.id)), result = {};
  for (const [id, revision] of Object.entries(value)) {
    notebookId(id);
    if (live.has(id) || !Number.isSafeInteger(revision) || revision < 1 || revision > document.revision) failNotebook('notebook_recovery_conflict', 'An imported deletion has an inconsistent revision.');
    result[id] = revision;
  }
  return result;
}
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
    for (const change of frame.changes) { if (change.after) objects.set(change.id, change.after); else objects.delete(change.id); state.tombstones[change.id] = change.revision; if (change.after && !Object.hasOwn(state.origins, change.id)) state.origins[change.id] = change.after.createdBy; }
    state.document = { ...state.document, revision: frame.sceneRevision, objects: [...objects.values()] };
  } else if (frame.kind === 'asset') {
    state.document.assets[frame.assetId] = frame.asset; state.document.revision = frame.sceneRevision;
  } else if (frame.kind === 'freeze') state.frozen.set(frame.operationId, frame.snapshot);
  else if (frame.kind === 'submit') {
    state.submissions.set(frame.operationId, frame.submission);
    state.knownSources.add(frame.submission.sourceHash);
  } else if (frame.kind === 'relocate') { state.locator = frame.locator; state.locations.push(frame.locator.revision); }
  else failNotebook('notebook_recovery_conflict', 'Unknown notebook history operation.');
  state.sequence = frame.sequence; state.chain = hash;
  state.receipts.set(frame.operationId, { file, actor: frame.actor, fingerprint: frame.fingerprint, receipt: frame.receipt });
  state.history.push({ sequence: frame.sequence, kind: frame.kind, operationId: frame.operationId, actor: frame.actor, at: frame.receipt.at, objectIds: (frame.changes || []).map(c => c.id) });
}
function readState(root, id) {
  const rootIdentity = canonicalNotebookRoot(root), folder = resourcePath(id);
  activateArrivals(root, id); assertNotMoved(root, id);
  const header = readNotebookJson(root, `${folder}/header.json`);
  if (!header || header.schemaVersion !== 1 || header.document.id !== id) failNotebook('notebook_missing', 'Notebook working scene not found.');
  if (!['same', 'alias', 'confirmed'].includes(acceptsRootIdentity(root, header.rootIdentity))) failNotebook('notebook_root_conflict', 'This working scene belongs to another exact filesystem location.');
  const state = { document: decodeNotebook(Buffer.from(JSON.stringify(header.document))), locator: header.locator, rootIdentity, sequence: Number.isSafeInteger(header.transferred?.sequence) && header.transferred.sequence > 0 ? header.transferred.sequence : 0,
    chain: notebookHash(header), tombstones: initialTombstones(header.document, header.tombstones), origins: Object.fromEntries(header.document.objects.map(o => [o.id, o.createdBy])), receipts: new Map(), frozen: new Map(), submissions: new Map(), knownSources: new Set([header.locator.sourceHash]), locations: [header.locator.revision], history: [] };
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
/** `createOnly` refuses an occupied path (a known notebook or an ordinary file) instead of opening it. */
export function openNotebook(root, { path, title = 'Notebook', id = randomUUID(), canWrite = () => false, createOnly = false } = {}) {
  canonicalNotebookRoot(root); path = notebookPath(path); notebookId(id);
  if (!canWrite(path)) failNotebook('notebook_path_scope', 'This folder has not been authorized for notebooks.');
  return withNotebookLock(root, `${NOTEBOOK_STORE}/registry.lock`, () => {
    for (const entry of listNotebooks(root)) if (entry.path === path) { if (createOnly) failNotebook('notebook_location_conflict', 'A notebook already uses this path. Choose another; nothing was opened.'); return readNotebook(root, entry.id); }
    const source = readNotebookBytes(root, path, NOTEBOOK_LIMITS.bytes);
    if (createOnly && source) failNotebook('notebook_location_conflict', 'A file already uses this path. Choose another; nothing was opened.');
    const document = source ? decodeNotebook(source) : emptyNotebook(id, title);
    assertNotMoved(root, document.id);
    if (readNotebookJson(root, `${resourcePath(document.id)}/header.json`)) failNotebook('notebook_location_conflict', 'This notebook identity is attached elsewhere. Relocate it explicitly or import a separate copy.');
    const rootIdentity = canonicalNotebookRoot(root), sourceHash = source ? notebookHash(source) : null;
    const locator = { path, sourceHash, revision: notebookHash({ rootIdentity, path, id: document.id, sourceHash }) };
    writeNotebookJson(root, `${resourcePath(document.id)}/header.json`, { schemaVersion: 1, rootIdentity, locator, document }, { exclusive: true });
    return readNotebook(root, document.id);
  });
}
/** Import one immutable source as working state. It never writes an ordinary file
 * or accepts a version; the original header is also its atomic replay receipt. */
export function importNotebookDraft(root, { path, document, tombstones = {}, requestId, sourceRevision } = {}, { canWrite = () => false, preview = false } = {}) {
  const rootIdentity = canonicalNotebookRoot(root); path = notebookPath(path); notebookId(requestId);
  if (typeof sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(sourceRevision)) failNotebook('notebook_recovery_conflict', 'An exact immutable import source revision is required.');
  document = decodeNotebook(encodeNotebook(document)); tombstones = initialTombstones(document, tombstones);
  if (document.objects.some(object => object.revision > document.revision || object.createdBy.kind !== 'import' || object.updatedBy.kind !== 'import')) failNotebook('notebook_recovery_conflict', 'Imported objects require consistent revisions and explicit import provenance.');
  if (!canWrite(path)) failNotebook('notebook_path_scope', 'This import destination is outside the editable document scope.');
  const id = document.id, locator = { path, sourceHash: null, revision: notebookHash({ rootIdentity, path, id, sourceHash: null }) };
  const identity = { schemaVersion: 1, rootIdentity, locator, document, tombstones };
  const imported = { requestId, sourceRevision, fingerprint: notebookHash({ ...identity, requestId, sourceRevision }) };
  const execute = () => {
    if (!canWrite(path)) failNotebook('notebook_path_scope', 'This import destination is outside the editable document scope.');
    const previous = readNotebookJson(root, `${resourcePath(id)}/header.json`);
    if (previous) {
      const { imported: receipt, ...initial } = previous;
      const previousRoot = previous.rootIdentity;
      const expectedLocator = { ...locator, revision: notebookHash({ rootIdentity: previousRoot, path, id, sourceHash: null }) };
      const expected = { ...identity, rootIdentity: previousRoot, locator: expectedLocator };
      const expectedImport = { requestId, sourceRevision, fingerprint: notebookHash({ ...expected, requestId, sourceRevision }) };
      if (!['same', 'alias', 'confirmed'].includes(acceptsRootIdentity(root, previousRoot)) || !receipt
        || notebookHash(receipt) !== notebookHash(expectedImport) || notebookHash(initial) !== notebookHash(expected)) failNotebook('notebook_location_conflict', 'This notebook identity already belongs to different working data. Nothing was replaced.');
      const state = readState(root, id); requireWrite(state, canWrite); assertLocation(root, state, state.locator.revision);
      return { ...publicState(state), imported: cloneNotebook(receipt), replayed: true, preview };
    }
    if (listNotebooks(root).some(entry => entry.path === path) || readNotebookBytes(root, path, NOTEBOOK_LIMITS.bytes) !== null) failNotebook('notebook_location_conflict', 'The import destination is occupied. Choose an unused notebook path; nothing was replaced.');
    if (preview) return { protocolVersion: NOTEBOOK_VERSION, resourceId: id, locator, revision: document.revision, document, tombstones, imported,
      accepted: false, replayed: false, preview: true };
    writeNotebookJson(root, `${resourcePath(id)}/header.json`, { ...identity, imported }, { exclusive: true });
    const state = readState(root, id); assertLocation(root, state, state.locator.revision);
    return { ...publicState(state), imported: cloneNotebook(imported), replayed: false, preview: false };
  };
  return preview ? execute() : withNotebookLock(root, `${NOTEBOOK_STORE}/registry.lock`, execute);
}
export function listNotebooks(root) {
  canonicalNotebookRoot(root); activateArrivals(root);
  const directory = safeNotebookPath(root, `${NOTEBOOK_STORE}/resources`);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).sort().filter(id => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id)).flatMap(id => {
    if (!readNotebookJson(root, `${resourcePath(id)}/header.json`) || readNotebookJson(root, movedPath(id))) return [];
    const state = readState(root, id);
    const changedAt = state.history.at(-1)?.at || fs.statSync(safeNotebookPath(root, `${resourcePath(id)}/header.json`)).mtime.toISOString();
    return [{ id, title: state.document.title, path: state.locator.path, revision: state.document.revision, locationRevision: state.locator.revision, changedAt, pending: true }];
  });
}
/** The move marker this root keeps after its notebook left, or null. */
export function notebookDeparture(root, id) {
  try { return readNotebookJson(root, movedPath(notebookId(id))); } catch { return null; }
}
/** Cheap proof that nothing `followNotebook` reads in this root changed: the header, the last event, the moved marker and
 * the pending arrivals (a few stat and readdir calls, no replay). Null when it cannot be computed. */
export function notebookFingerprint(root, id) {
  try {
    id = notebookId(id);
    const stat = rel => { try { const s = fs.statSync(safeNotebookPath(root, rel)); return [s.ino, s.size, s.mtimeMs]; } catch { return null; } };
    const names = rel => { try { return fs.readdirSync(safeNotebookPath(root, rel)).sort(); } catch { return null; } };
    const events = names(`${resourcePath(id)}/events`), incoming = names(`${NOTEBOOK_STORE}/incoming`);
    return JSON.stringify([canonicalNotebookRoot(root), stat(`${resourcePath(id)}/header.json`), stat(movedPath(id)), events?.length ?? null, events?.at(-1) ?? null, incoming]);
  } catch { return null; }
}
const acceptedRoot = (root, identity) => ['same', 'alias', 'confirmed'].includes(acceptsRootIdentity(root, identity));
/** Current location of the notebook active in `root`, only when it provably is the notebook recorded at
 * `origin` ({ root, rootIdentity, locationRevision }); otherwise null. A resourceId alone proves nothing:
 * a copied `.crnb` keeps it. Same root: the notebook's own relocation chain holds the recorded location.
 * Another root: walk back hop by hop. Each arrival header names its source root and move; that source
 * must hold the commit of this exact move (its retired copy, or its moved marker before retirement). */
export function followNotebook(root, id, origin, { maxHops = 32 } = {}) {
  id = notebookId(id);
  let state; try { state = readState(root, id); } catch { return null; }
  const here = { path: state.locator.path, locationRevision: state.locator.revision };
  const isOrigin = candidate => candidate === origin.root && acceptedRoot(candidate, origin.rootIdentity);
  if (isOrigin(root) && state.locations.includes(origin.locationRevision)) return here;
  let header = readNotebookJson(root, `${resourcePath(id)}/header.json`);
  for (let hop = 0; hop < maxHops; hop++) {
    const move = header?.transferred, from = move?.from;
    if (header?.document?.id !== id || typeof move?.operationId !== 'string' || typeof from?.root !== 'string' || typeof from.rootIdentity !== 'string') return null;
    let previous;
    try {
      if (canonicalNotebookRoot(from.root) !== from.rootIdentity) return null;
      previous = readNotebookJson(from.root, `${NOTEBOOK_STORE}/retired/${id}-${notebookId(move.operationId)}/header.json`);
      if (!previous) {
        if (readNotebookJson(from.root, movedPath(id))?.operationId !== move.operationId) return null;
        previous = readNotebookJson(from.root, `${resourcePath(id)}/header.json`);
      }
    } catch { return null; }
    if (isOrigin(from.root)) return here;
    header = previous;
  }
  return null;
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
function withTransferLocks(sourceRoot, targetRoot, operation) {
  // Two roots are always locked in one order, so opposite moves cannot wait on each other.
  const [first, second] = [sourceRoot, targetRoot].sort((a, b) => canonicalNotebookRoot(a) < canonicalNotebookRoot(b) ? -1 : 1);
  return withNotebookLock(first, `${NOTEBOOK_STORE}/registry.lock`, () => withNotebookLock(second, `${NOTEBOOK_STORE}/registry.lock`, operation));
}
const liveTombstones = (document, tombstones) => { const live = new Set(document.objects.map(o => o.id)); return Object.fromEntries(Object.entries(tombstones).filter(([id]) => !live.has(id)).sort()); };
/** Paths that working notebooks of `root` hold. A notebook that cannot be read keeps the
 * path of its header, so one damaged notebook never blocks a move to another path. */
function occupiedNotebookPaths(root, arrivingId) {
  const paths = new Set(), store = name => safeNotebookPath(root, `${NOTEBOOK_STORE}/${name}`);
  const headerPath = rel => { try { const header = readNotebookJson(root, `${rel}/header.json`); if (typeof header?.locator?.path === 'string') paths.add(header.locator.path); } catch { /* no known path */ } };
  if (fs.existsSync(store('resources'))) for (const id of fs.readdirSync(store('resources')).sort()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id)) continue;
    try { if (readNotebookJson(root, movedPath(id))) continue; paths.add(readState(root, id).locator.path); }
    catch (error) { if (error.code !== 'notebook_moved') headerPath(resourcePath(id)); }
  }
  // Copies staged for another notebook may be committed already: their path is taken too.
  if (fs.existsSync(store('incoming'))) for (const name of fs.readdirSync(store('incoming')).sort()) if (!name.startsWith('.') && stagedArrival(root, name)?.id !== arrivingId) headerPath(`${NOTEBOOK_STORE}/incoming/${name}`);
  return paths;
}
/** One move identifier per notebook incarnation and destination: a re-run after a crash
 * finds its own journal, and a notebook that came back gets a new identifier. */
export function notebookTransferOperationId(sourceRoot, targetRoot, resourceId, prefix = 'move') {
  const header = readNotebookJson(sourceRoot, `${resourcePath(resourceId)}/header.json`);
  if (!header) failNotebook('notebook_missing', 'Notebook working scene not found.');
  return notebookId(`${prefix}-${notebookHash({ resourceId, target: canonicalNotebookRoot(targetRoot), header: notebookHash(header) }).slice(0, 40)}`);
}
/** Moves from `sourceRoot` to `targetRoot` that passed their commit point but stopped before the source was retired. */
export function interruptedNotebookTransfers(sourceRoot, targetRoot) {
  const targetIdentity = canonicalNotebookRoot(targetRoot), directory = safeNotebookPath(sourceRoot, `${NOTEBOOK_STORE}/transfers`);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).sort().flatMap(name => {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,95})\.json$/.exec(name), journal = match && readNotebookJson(sourceRoot, `${NOTEBOOK_STORE}/transfers/${name}`);
    if (!journal || journal.operationId !== match[1] || journal.target !== targetIdentity) return [];
    if (readNotebookJson(sourceRoot, movedPath(journal.resourceId))?.operationId !== journal.operationId) return [];
    return fs.existsSync(safeNotebookPath(sourceRoot, `${NOTEBOOK_STORE}/retired/${journal.resourceId}-${journal.operationId}`)) ? [] : [cloneNotebook(journal)];
  });
}
function assertWorkingOnly(sourceRoot, state) {
  if (state.locator.sourceHash || readNotebookBytes(sourceRoot, state.locator.path, NOTEBOOK_LIMITS.bytes) !== null) failNotebook('notebook_move_published', 'This notebook has a reviewed file. Only working notebooks move; nothing changed.');
  if (state.submissions.size) failNotebook('notebook_move_published', 'This notebook was submitted for review. Finish that review first; nothing changed.');
}
/** The source half of a move preview, for a destination that does not exist yet. Writes
 * nothing; the revision changes with any edit or relocation of the notebook. */
export function previewNotebookDeparture(sourceRoot, request = {}, { canWriteSource = () => false } = {}) {
  const id = notebookId(request.resourceId), serverId = notebookServerId(sourceRoot);
  const state = readState(sourceRoot, id); requireWrite(state, canWriteSource); assertWorkingOnly(sourceRoot, state);
  return { resourceId: id, title: state.document.title, from: { serverId, path: state.locator.path },
    revision: notebookHash({ departure: true, serverId, id, revision: state.document.revision, sequence: state.sequence, locationRevision: state.locator.revision }) };
}
/** Move one working notebook to another root. Steps: journal (source), staged copy
 * (target incoming/, invisible), moved marker (source, the commit point), activation of the
 * copy, retirement of the source (kept under retired/, never deleted). A crash at any step
 * leaves exactly one active copy. The same operationId resumes a committed move; a move
 * that stopped before its commit is cancelled when the source changed since its preview.
 * A published or submitted notebook does not move. Undo history stays with the retired source. */
export function transferNotebook(sourceRoot, targetRoot, request = {}, { canWriteSource = () => false, canWriteTarget = () => false, preview = false, destination = {} } = {}) {
  const id = notebookId(request.resourceId), path = notebookPath(request.path);
  const sourceIdentity = canonicalNotebookRoot(sourceRoot), targetIdentity = canonicalNotebookRoot(targetRoot);
  if (sourceIdentity === targetIdentity) failNotebook('notebook_location_conflict', 'The notebook is already in this place.');
  const from = { serverId: notebookServerId(sourceRoot, sourceIdentity) };
  const to = { ...cloneNotebook(destination), serverId: notebookServerId(targetRoot, targetIdentity), path };
  const plan = () => {
    const state = readState(sourceRoot, id); requireWrite(state, canWriteSource);
    if (!canWriteTarget(path)) failNotebook('notebook_path_scope', 'The destination folder is not authorized for notebooks.');
    assertWorkingOnly(sourceRoot, state);
    const revision = notebookHash({ serverId: from.serverId, id, revision: state.document.revision, sequence: state.sequence, locationRevision: state.locator.revision, target: targetIdentity, path });
    return { state, revision };
  };
  const assertFree = () => {
    if (readNotebookJson(targetRoot, `${resourcePath(id)}/header.json`) || occupiedNotebookPaths(targetRoot, id).has(path)
      || readNotebookBytes(targetRoot, path, NOTEBOOK_LIMITS.bytes) !== null) failNotebook('notebook_location_conflict', 'The destination already holds this notebook or this path. Nothing was overwritten.');
  };
  if (preview) {
    const { state, revision } = plan(); assertFree();
    return { protocolVersion: NOTEBOOK_VERSION, preview: true, resourceId: id, title: state.document.title, revision, sceneRevision: state.document.revision,
      from: { ...from, path: state.locator.path }, to, overwrites: false, accepted: false };
  }
  const operationId = notebookId(request.operationId), journalRel = `${NOTEBOOK_STORE}/transfers/${operationId}.json`;
  const retiredRel = `${NOTEBOOK_STORE}/retired/${id}-${operationId}`, stagedRel = incomingPath(id, operationId);
  const retire = () => {
    const current = safeNotebookPath(sourceRoot, resourcePath(id)), retired = safeNotebookPath(sourceRoot, retiredRel);
    if (fs.existsSync(current) && !fs.existsSync(retired)) {
      makeNotebookDirectory(sourceRoot, `${NOTEBOOK_STORE}/retired`);
      fs.renameSync(current, retired); syncNotebookDirectory(safeNotebookPath(sourceRoot, `${NOTEBOOK_STORE}/retired`));
    }
  };
  // Nothing was committed: the staged copy is only a copy and the source stays active.
  const cancel = operation => {
    fs.rmSync(safeNotebookPath(targetRoot, incomingPath(id, operation)), { recursive: true, force: true });
    const journal = safeNotebookPath(sourceRoot, `${NOTEBOOK_STORE}/transfers/${operation}.json`);
    if (fs.existsSync(journal)) { fs.renameSync(journal, safeNotebookPath(sourceRoot, `${NOTEBOOK_STORE}/transfers/${operation}.cancelled.json`)); syncNotebookDirectory(safeNotebookPath(sourceRoot, `${NOTEBOOK_STORE}/transfers`)); }
  };
  const result = (journal, replayed) => {
    const scene = readNotebook(targetRoot, id, { includeDocument: false });
    return { protocolVersion: NOTEBOOK_VERSION, operationId, resourceId: id, moved: true, from: cloneNotebook(journal.from), to: cloneNotebook(journal.to),
      revision: scene.revision, locationRevision: scene.locator.revision, retired: retiredRel, replayed, accepted: false };
  };
  return withTransferLocks(sourceRoot, targetRoot, () => {
    let journal = readNotebookJson(sourceRoot, journalRel);
    if (journal && (journal.resourceId !== id || journal.target !== targetIdentity || journal.to.path !== path)) failNotebook('notebook_replay_conflict', 'This move identifier was used for another move.');
    if (journal && readNotebookJson(sourceRoot, movedPath(id))?.operationId === operationId) { completeArrival(targetRoot, id, operationId); retire(); return result(journal, true); }
    if (fs.existsSync(safeNotebookPath(sourceRoot, retiredRel))) failNotebook('notebook_replay_conflict', 'This move already finished and the notebook came back. Preview the move again.');
    let replayed = Boolean(journal);
    withNotebookLock(sourceRoot, `${resourcePath(id)}/mutation.lock`, () => {
      const { state, revision } = plan();
      if (journal && journal.revision !== revision) { cancel(operationId); journal = null; replayed = false; }
      if (request.expectedRevision !== revision) failNotebook('notebook_location_stale', 'The notebook changed after the preview. Preview the move again.');
      const tombstones = liveTombstones(state.document, state.tombstones), documentHash = notebookHash(encodeNotebook(state.document));
      if (!journal) {
        assertFree();
        // Older interrupted moves of this notebook from this source never reached their commit point.
        const incoming = safeNotebookPath(targetRoot, `${NOTEBOOK_STORE}/incoming`);
        if (fs.existsSync(incoming)) for (const name of fs.readdirSync(incoming)) {
          const staged = stagedArrival(targetRoot, name);
          if (staged?.id === id && staged.operationId !== operationId && staged.from?.rootIdentity === sourceIdentity) cancel(staged.operationId);
        }
        journal = { schemaVersion: 1, operationId, resourceId: id, revision, target: targetIdentity, from: { ...from, path: state.locator.path, locationRevision: state.locator.revision },
          to, documentHash, tombstonesHash: notebookHash(tombstones), at: new Date().toISOString() };
        writeNotebookJson(sourceRoot, journalRel, journal, { exclusive: true });
      }
      if (!readNotebookJson(targetRoot, `${stagedRel}/header.json`)) {
        assertFree();
        const locator = { path, sourceHash: null, revision: notebookHash({ rootIdentity: targetIdentity, path, id, sourceHash: null, transfer: operationId }) };
        writeNotebookJson(targetRoot, `${stagedRel}/header.json`, { schemaVersion: 1, rootIdentity: targetIdentity, locator, document: state.document, tombstones,
          transferred: { operationId, sequence: state.sequence + 1, from: { serverId: from.serverId, path: state.locator.path, revision: state.locator.revision, root: sourceRoot, rootIdentity: sourceIdentity } } }, { exclusive: true });
      }
      const staged = readNotebookJson(targetRoot, `${stagedRel}/header.json`);
      let copy;
      try { copy = decodeNotebook(Buffer.from(JSON.stringify(staged.document))); initialTombstones(copy, staged.tombstones); } catch { copy = null; }
      if (!copy || staged.rootIdentity !== targetIdentity || staged.transferred?.operationId !== operationId || staged.locator?.path !== path
        || notebookHash(encodeNotebook(copy)) !== journal.documentHash || notebookHash(liveTombstones(copy, staged.tombstones)) !== journal.tombstonesHash) {
        failNotebook('notebook_recovery_conflict', 'The copied notebook does not match its source. The source is unchanged and still active.');
      }
      // The destination may have been taken while an interrupted move waited.
      assertFree();
      writeNotebookJson(sourceRoot, movedPath(id), { schemaVersion: 1, operationId, resourceId: id, to: journal.to, at: new Date().toISOString() });
    });
    completeArrival(targetRoot, id, operationId);
    // The mutation lock lives inside the folder being retired: rename after its release.
    // Writers that waited for it now read the moved marker and receive notebook_moved.
    retire();
    return result(journal, replayed);
  });
}
