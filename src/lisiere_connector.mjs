import path from 'node:path';
import fs from 'node:fs';
import { emptyNotebook, notebookPath } from './notebook_protocol.mjs';
import { importNotebookDraft, readNotebook, encodeNotebook } from './notebooks.mjs';
import { notebookImageSize } from './notebook_images.mjs';
import { notebookSvg } from './notebook_render.mjs';
import { canonicalNotebookRoot, notebookHash, readNotebookBytes, readNotebookJson, safeNotebookPath, stableNotebookJson, withNotebookLock } from './notebook_io.mjs';
import { retainLisiereRecoveryBytes } from './lisiere_migration.mjs';
import { convertLisiereBoard } from './lisiere_notebook.mjs';

const MAX = 20 * 1024 * 1024, SESSIONS = '.context-room/lisiere/sessions';
const fault = (message, code = 'drawing_recovery_conflict') => Object.assign(new Error(message), { code, statusCode: 409 });
const check = (value, message, code) => { if (!value) throw fault(message, code); };
const bytes = value => Buffer.from(stableNotebookJson(value) + '\n');
const uuid = hash => `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
const folder = id => { check(typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id), 'Choose an exact retained drawing session.'); return `${SESSIONS}/${id}`; };
function png(value) {
  check(Buffer.isBuffer(value) && value.length <= MAX, 'Choose a bounded original PNG drawing.');
  const size = notebookImageSize(value, 'image/png');
  check(size.width <= 4096 && size.height <= 4096 && size.width * size.height <= 16_000_000, 'This drawing exceeds the native correction preview size. Keep the original resolution for separate recovery.');
  return size;
}
function originalSource(value) {
  check(value && typeof value === 'object' && !Array.isArray(value) && typeof value.path === 'string' && typeof value.revision === 'string' && value.revision.length > 0,
    'Bind the drawing to the exact reviewed document revision.');
  check(!path.posix.isAbsolute(value.path) && !value.path.includes('\\') && value.path.split('/').every(part => part && part !== '.' && part !== '..'), 'The original drawing source path is unsafe.');
  check(bytes(value).length <= 8192, 'The drawing source binding is oversized.');
  return JSON.parse(stableNotebookJson(value));
}
function imageDocument(id, title, content) {
  const size = png(content), hash = notebookHash(content), actor = { kind: 'import', id };
  const document = emptyNotebook(id, title);
  document.revision = 1; document.assets[hash] = { mimeType: 'image/png', data: content.toString('base64') };
  document.objects.push({ id: 'original-image', type: 'image', asset: hash, x: 0, y: 0, width: size.width, height: size.height,
    revision: 1, createdBy: actor, updatedBy: actor });
  return { document, size };
}

/** Compatibility name only. The production path never executes a legacy CLI or
 * contacts a legacy service. Rendering uses the real native notebook engine. */
export function createLisiereConnector({ canWrite = () => false, beforeWrite = () => {} } = {}) {
  return {
    async status() { return { available: true, native: true, protocol: 1, automaticTabletNavigation: false,
      legacyRuntimeRequired: false, recovery: 'migrate --legacy-session', instruction: 'Draw in a Context Room working notebook, then review an exact PNG snapshot.' }; },
    async prepare(root, { source, bytes: content, title, destination } = {}) {
      const rootIdentity = canonicalNotebookRoot(root); source = originalSource(source); destination = notebookPath(destination); png(content);
      check(destination !== source.path, 'Keep editable notebook source separate from the original PNG review.');
      const inputHash = notebookHash({ rootIdentity, source, destination, imageHash: notebookHash(content), title });
      const id = uuid(inputHash), directory = folder(id), { document, size } = imageDocument(id, title || path.posix.basename(destination), content);
      const input = { path: destination, document, requestId: id, sourceRevision: inputHash };
      importNotebookDraft(root, input, { canWrite, preview: true }); // Permission and occupancy before any writes.
      const session = { version: 2, id, source, rootIdentity, title: document.title, width: size.width, height: size.height,
        sourceHash: notebookHash(content), native: { resourceId: id, path: destination, requestId: id, inputHash }, state: 'native-working' };
      beforeWrite();
      retainLisiereRecoveryBytes(root, `${directory}/session.json`, bytes(session));
      retainLisiereRecoveryBytes(root, `${directory}/workspace/source.png`, content);
      const scene = importNotebookDraft(root, input, { canWrite });
      check(canonicalNotebookRoot(root) === rootIdentity, 'The original project location changed during drawing preparation.');
      return { id, boardId: id, resourceId: id, path: destination, title: document.title, state: 'ready', accepted: false,
        replayed: scene.replayed, automaticTabletNavigation: false, native: true,
        instruction: 'The editable drawing is in Context Room. Drawing and autosave do not accept this PNG. Use a saved snapshot, inspect it, then decide this file.' };
    },
    async read(root, id, source) {
      const directory = folder(id), session = readNotebookJson(root, `${directory}/session.json`);
      check(session && notebookHash(originalSource(source)) === notebookHash(session.source), 'This drawing belongs to a different document revision.');
      check(session.version === 2 && session.native, 'This is an original Lisière transfer. Inspect and explicitly recover its retained source, board or preview with migrate --legacy-session; no old service is started.', 'lisiere_session_recovery');
      check(session.id === id && session.rootIdentity === canonicalNotebookRoot(root) && canWrite(session.native.path), 'The original drawing location or its permission is unavailable.');
      const original = readNotebookBytes(root, `${directory}/workspace/source.png`, MAX);
      check(original && notebookHash(original) === session.sourceHash, 'The retained original image changed. Nothing was imported.');
      const scene = readNotebook(root, session.native.resourceId), documentBytes = encodeNotebook(scene.document), hash = notebookHash(documentBytes);
      check(scene.locator.path === session.native.path, 'The drawing moved. Reconcile its destination explicitly before importing a correction.');
      const editableSource = `${directory}/board-${scene.revision}-${hash}.crnb`;
      retainLisiereRecoveryBytes(root, editableSource, documentBytes);
      return { native: true, accepted: false, boardRevision: scene.revision, snapshotHash: hash, editableBoardId: scene.resourceId,
        path: scene.locator.path, editableSource, width: session.width, height: session.height,
        svg: notebookSvg(scene.document, { bounds: { x: 0, y: 0, width: session.width, height: session.height } }) };
    },
  };
}

/** A legacy frame selector is explicit: neither the highest revision nor an
 * uncertain task identity is treated as the person's intended recovery. */
export function inspectLisiereSession(root, id) {
  canonicalNotebookRoot(root); const directory = folder(id), session = readNotebookJson(root, `${directory}/session.json`);
  check(session && session.id === id && !session.native, 'Choose an original retained Lisière transfer session.');
  const original = readNotebookBytes(root, `${directory}/workspace/source.png`, MAX); check(original, 'The original drawing source is missing.'); png(original);
  const names = fs.readdirSync(safeNotebookPath(root, directory)); check(names.length <= 1000, 'This transfer requires a bounded explicit inventory.');
  const candidates = [{ frame: 'source', file: 'workspace/source.png', kind: 'raster', bytes: original.length, sha256: notebookHash(original) }];
  for (const name of names.sort()) {
    const match = /^(board|preview)-(0|[1-9][0-9]{0,15})\.(json|png)$/.exec(name);
    if (!match || match[3] !== (match[1] === 'board' ? 'json' : 'png')) continue;
    const content = readNotebookBytes(root, `${directory}/${name}`, MAX); check(content, 'A retained drawing frame disappeared.');
    candidates.push({ frame: `${match[1]}:${match[2]}`, file: name, kind: match[1] === 'board' ? 'structured' : 'raster',
      bytes: content.length, sha256: notebookHash(content) });
  }
  return { kind: 'lisiere-session-inventory', id, source: session.source, accepted: false, delivery: 'not-inferred', candidates,
    instruction: 'Select one exact frame and an unused ordinary .crnb path. Unknown assets or object formats require separate reconciliation; all originals remain untouched.' };
}

function legacySessionPlan(root, options, canWrite) {
  const rootIdentity = canonicalNotebookRoot(root), directory = folder(options.sessionId), inventory = inspectLisiereSession(root, options.sessionId);
  const selected = inventory.candidates.find(item => item.frame === options.frame);
  check(selected, 'Choose an exact --session-frame from the retained transfer inventory.');
  const destination = notebookPath(options.path), sessionBytes = readNotebookBytes(root, `${directory}/session.json`, MAX), session = JSON.parse(sessionBytes.toString());
  const original = readNotebookBytes(root, `${directory}/workspace/source.png`, MAX), selectedBytes = readNotebookBytes(root, `${directory}/${selected.file}`, MAX);
  check(original && selectedBytes && notebookHash(selectedBytes) === selected.sha256, 'The selected original drawing changed during recovery.');
  const identity = { rootIdentity, sessionId: options.sessionId, sessionHash: notebookHash(sessionBytes), originalHash: notebookHash(original), selected, destination };
  const sourceRevision = notebookHash(identity), requestId = uuid(sourceRevision);
  let document, tombstones = {}, mapping = [], structured = false;
  if (selected.kind === 'raster') ({ document } = imageDocument(requestId, session.title || 'Recovered drawing', selectedBytes));
  else {
    let board; try { board = JSON.parse(selectedBytes.toString('utf8')); } catch { throw fault('The retained board JSON is damaged. Its original bytes remain available.'); }
    check(board && Array.isArray(board.objects) && Number.isSafeInteger(board.revision) && String(board.revision) === options.frame.slice(6), 'The retained structured frame has an inconsistent global revision.');
    check(typeof session.boardId === 'string' && (!board.id || board.id === session.boardId), 'The retained structured frame belongs to a different original board.');
    // Supported original projections retain exact id/revision alongside either
    // a flat object or its explicit value. No absent revisions are manufactured.
    const rows = board.objects.map(object => {
      check(object && typeof object.id === 'string' && Number.isSafeInteger(object.revision), 'An original object lacks an exact identity or revision. Preserve this board for explicit reconciliation.');
      const value = Object.hasOwn(object, 'value') ? object.value : object;
      const deleted = object.deleted === true || value === null;
      return { board: session.boardId, id: object.id, revision: object.revision, data: deleted ? null : JSON.stringify(value) };
    });
    const converted = convertLisiereBoard({ id: session.boardId, title: session.title || 'Recovered drawing', revision: board.revision,
      project: session.projectId || null, directory: '', anchor: { contextRoom: session.source } }, rows, hash => {
      check(hash === notebookHash(original), 'An original board image is not retained in this transfer. Recover its exact asset before importing structured objects.'); return original;
    });
    document = { ...converted.document, id: requestId }; tombstones = converted.tombstones; mapping = converted.idMapping; structured = true;
  }
  const input = { path: destination, document, tombstones, requestId, sourceRevision };
  const current = importNotebookDraft(root, input, { canWrite, preview: true });
  const config = readNotebookBytes(root, '.context-room/config.json', 8 * 1024 * 1024);
  const revision = notebookHash({ identity, configHash: config === null ? null : notebookHash(config), documentHash: notebookHash(encodeNotebook(document)), mapping });
  return { input, sessionBytes, original, selectedBytes, selected, mapping, identity, summary: { kind: 'lisiere-session-import', revision,
    sourceRevision, sessionId: options.sessionId, frame: options.frame, path: destination, resourceId: document.id, structured,
    objects: document.objects.length, accepted: false, delivery: 'not-inferred', legacyTaskChanged: false, replayed: current.replayed } };
}

export function migrateLisiereSession(root, options, { canWrite = () => false, beforeWrite = () => {} } = {}) {
  if (!options.frame && !options.apply && !options.path) return inspectLisiereSession(root, options.sessionId);
  const plan = legacySessionPlan(root, options, canWrite);
  if (!options.apply) return { ...plan.summary, applied: false };
  check(options.expectedRevision === plan.summary.revision, 'The original transfer, chosen destination or permissions changed after preview.');
  return withNotebookLock(root, '.context-room/migrations/lisiere-sessions-v1/import.lock', () => {
    const current = legacySessionPlan(root, options, canWrite);
    check(current.summary.revision === plan.summary.revision, 'The selected transfer changed before recovery.'); beforeWrite();
    const recovery = `.context-room/migrations/lisiere-sessions-v1/${plan.input.requestId}`;
    retainLisiereRecoveryBytes(root, `${recovery}/plan.json`, bytes({ ...plan.identity, selected: plan.selected, mapping: plan.mapping, accepted: false }));
    retainLisiereRecoveryBytes(root, `${recovery}/original-session.json`, plan.sessionBytes);
    retainLisiereRecoveryBytes(root, `${recovery}/source.png`, plan.original);
    retainLisiereRecoveryBytes(root, `${recovery}/selected.${plan.selected.kind === 'raster' ? 'png' : 'json'}`, plan.selectedBytes);
    check(legacySessionPlan(root, options, canWrite).summary.revision === plan.summary.revision, 'The original transfer changed while retaining recovery evidence.');
    const imported = importNotebookDraft(root, plan.input, { canWrite });
    return { ...plan.summary, applied: true, replayed: imported.replayed, recovery, currentRevision: imported.revision };
  });
}
