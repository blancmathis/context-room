import { readLisiereSnapshot, legacyError } from './lisiere_archive.mjs';
import { convertLisiereBoard } from './lisiere_notebook.mjs';
import { importNotebookDraft, encodeNotebook } from './notebooks.mjs';
import { canonicalNotebookRoot, notebookHash, stableNotebookJson, readNotebookBytes, writeNotebookBytes, withNotebookLock } from './notebook_io.mjs';

const STORE = '.context-room/migrations/lisiere-v1';
const MAX_SOURCE = 32 * 1024 * 1024;
const jsonBytes = value => Buffer.from(stableNotebookJson(value) + '\n');
function requireValue(value, message) { if (!value) throw legacyError(message); }
function archivedRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    Buffer.isBuffer(value) ? { base64: value.toString('base64') } : typeof value === 'bigint' ? { integer: String(value) } : value]));
}
function configHash(root) {
  const bytes = readNotebookBytes(root, '.context-room/config.json', 8 * 1024 * 1024);
  return bytes === null ? null : notebookHash(bytes);
}
function prepare(root, { snapshot, boardId, path } = {}, canWrite) {
  const rootIdentity = canonicalNotebookRoot(root);
  requireValue(typeof snapshot === 'string' && typeof boardId === 'string' && boardId.length > 0 && boardId.length <= 512, 'Choose an exact completed snapshot and legacy board ID.');
  const archive = readLisiereSnapshot(snapshot);
  requireValue(archive.manifest.kind === 'mac-workspace', 'This import needs the canonical Mac snapshot. Tablet recovery is a separate reconciliation step.');
  let board = null;
  for (const row of archive.rows('boards')) if (row.id === boardId) {
    requireValue(!board, 'The legacy snapshot contains duplicate board identities.'); board = row;
  }
  requireValue(board, 'The selected legacy board is absent from this snapshot.');
  const rows = []; let sourceBytes = Buffer.byteLength(stableNotebookJson(archivedRow(board)));
  for (const row of archive.rows('objects')) if (row.board === boardId) {
    sourceBytes += Buffer.byteLength(stableNotebookJson(archivedRow(row)));
    requireValue(sourceBytes <= MAX_SOURCE, 'The original board exceeds the bounded recovery copy. Retain its source snapshot.'); rows.push(row);
  }
  const assets = new Map();
  const converted = convertLisiereBoard(board, rows, hash => { const bytes = archive.asset(hash); assets.set(hash, bytes); return bytes; });
  const requestId = `lisiere-${notebookHash({ rootIdentity, sourceRevision: archive.manifest.revision, boardId, path })}`;
  const input = { path, document: converted.document, tombstones: converted.tombstones, requestId, sourceRevision: archive.manifest.revision };
  const current = importNotebookDraft(root, input, { canWrite, preview: true });
  const recovery = `${STORE}/${requestId}`;
  const files = new Map([['source-board.json', jsonBytes({ version: 1, sourceRevision: archive.manifest.revision,
    board: archivedRow(board), objects: rows.map(archivedRow), idMapping: converted.idMapping })],
    ...[...assets].sort(([a], [b]) => a.localeCompare(b)).map(([hash, bytes]) => [`assets/${hash}`, bytes])]);
  requireValue(files.get('source-board.json').length <= MAX_SOURCE, 'The original board and identity map exceed the bounded recovery copy.');
  const identity = { version: 1, kind: 'lisiere-notebook-import', rootIdentity,
    sourceRevision: archive.manifest.revision, source: converted.source, path, resourceId: converted.document.id,
    documentHash: notebookHash(encodeNotebook(converted.document)), requestId, recovery,
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: notebookHash(bytes) })), accepted: false };
  const authority = { migrationRevision: notebookHash(identity), configHash: configHash(root) };
  const revision = notebookHash(authority);
  return { identity, authority, revision, input, current, files, summary: {
    version: 1, kind: identity.kind, revision, sourceRevision: identity.sourceRevision, source: converted.source,
    path, resourceId: identity.resourceId, requestId, recovery, accepted: false, imported: current.replayed,
    objects: converted.document.objects.length, deletedObjects: Object.keys(converted.tombstones).length,
    assets: assets.size, currentRevision: current.replayed ? current.revision : null,
  } };
}

/** Preview performs no filesystem writes, including when the project has no store yet. */
export function planLisiereNotebookImport(root, options, { canWrite = () => false } = {}) {
  return { ...prepare(root, options, canWrite).summary, applied: false };
}

export function retainLisiereRecoveryBytes(root, rel, bytes) {
  let existing = readNotebookBytes(root, rel, MAX_SOURCE);
  if (existing === null) {
    try { writeNotebookBytes(root, rel, bytes, { exclusive: true }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    existing = readNotebookBytes(root, rel, MAX_SOURCE);
  }
  requireValue(existing?.equals(bytes), 'The retained migration copy or receipt changed. Reconcile it without replacing newer work.');
}
const retain = retainLisiereRecoveryBytes;

/** Durable phase receipts permit recovery after any acknowledgement is lost.
 * Only selected board data is copied into this project, never other projects,
 * credentials, accepted versions or the legacy operation queue. */
export function applyLisiereNotebookImport(root, options, { canWrite = () => false, beforeWrite = () => {} } = {}) {
  requireValue(typeof options?.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(options.expectedRevision), 'Apply requires the exact migration preview revision.');
  const prepared = prepare(root, options, canWrite);
  requireValue(prepared.revision === options.expectedRevision, 'The migration source, destination or configuration changed after its preview.');
  return withNotebookLock(root, `${STORE}/migration.lock`, () => {
    const { identity, authority, revision, files, input, summary } = prepared;
    const recheck = () => requireValue(canonicalNotebookRoot(root) === identity.rootIdentity && configHash(root) === authority.configHash,
      'The project or configuration changed during migration. Retained recovery data remains available.');
    recheck();
    // Recheck current write authority and path occupancy before retaining data.
    importNotebookDraft(root, input, { canWrite, preview: true });
    beforeWrite(); recheck();
    retain(root, `${identity.recovery}/plan.json`, jsonBytes(identity));
    retain(root, `${identity.recovery}/authorizations/${revision}.json`, jsonBytes({ ...authority, revision }));
    for (const [rel, bytes] of files) retain(root, `${identity.recovery}/${rel}`, bytes);
    const receipt = { version: 1, migrationRevision: authority.migrationRevision, requestId: identity.requestId, resourceId: identity.resourceId, accepted: false };
    const completed = readNotebookBytes(root, `${identity.recovery}/applied.json`);
    requireValue(completed === null || completed.equals(jsonBytes(receipt)), 'The existing migration completion receipt changed. No working notebook was replaced.');
    retain(root, `${identity.recovery}/backed-up.json`, jsonBytes(receipt));
    recheck();
    const imported = importNotebookDraft(root, input, { canWrite });
    retain(root, `${identity.recovery}/applied.json`, jsonBytes(receipt));
    return { ...summary, applied: true, imported: true, replayed: imported.replayed, currentRevision: imported.revision,
      locator: imported.locator, receipt: `${identity.recovery}/applied.json` };
  });
}
