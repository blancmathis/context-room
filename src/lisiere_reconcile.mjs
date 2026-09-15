import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLisiereSnapshot, legacyError } from './lisiere_archive.mjs';
import { convertLisiereBoard } from './lisiere_notebook.mjs';
import { importNotebookDraft, encodeNotebook } from './notebooks.mjs';
import { canonicalNotebookRoot, notebookHash, stableNotebookJson, readNotebookBytes, withNotebookLock } from './notebook_io.mjs';
import { retainLisiereRecoveryBytes } from './lisiere_migration.mjs';

const LIMIT = 64 * 1024 * 1024;
const STORE = '.context-room/migrations/lisiere-reconciliation-v1';
const script = fileURLToPath(new URL('./lisiere_reconcile.py', import.meta.url));
const check = (ok, message) => { if (!ok) throw legacyError(message); };
const bytes = value => Buffer.from(stableNotebookJson(value) + '\n');
const cells = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
  Buffer.isBuffer(value) ? { base64: value.toString('base64') } : typeof value === 'bigint' ? { integer: String(value) } : value]));
const config = root => { const raw = readNotebookBytes(root, '.context-room/config.json', 8 * 1024 * 1024); return raw === null ? null : notebookHash(raw); };

/** Pure comparison of two complete exports. No operation is sent or acknowledged. */
export function inspectLisiereReconciliation({ androidSnapshot, macSnapshot, boardId, actor } = {}) {
  check(typeof boardId === 'string' && boardId && typeof actor === 'string' && actor, 'Choose the exact original board and original tablet actor. Neither is inferred.');
  const android = readLisiereSnapshot(androidSnapshot), mac = readLisiereSnapshot(macSnapshot);
  check(android.manifest.kind === 'android-workspace' && mac.manifest.kind === 'mac-workspace', 'Select an Android recovery snapshot and its canonical Mac snapshot.');
  const wire = new Map([...android.androidArguments()].map(row => [row.seq, row]));
  const queue = []; let count = 0;
  for (const row of android.rows('outbox')) {
    const entry = { row: cells(row), wire: wire.get(String(row.seq)) || null }; count += bytes(entry).length;
    check(count <= LIMIT / 2 && queue.length < 100000, 'This queue exceeds the bounded reconciliation input. Its original export remains complete.'); queue.push(entry);
  }
  const ids = new Set(queue.map(entry => entry.row.id));
  const selected = (name, predicate = () => true) => {
    const rows = [];
    for (const row of mac.rows(name)) if (predicate(row)) {
      const encoded = cells(row); count += bytes(encoded).length;
      check(count <= LIMIT, 'Selected historical records exceed the reconciliation bound.'); rows.push(encoded);
    }
    return rows;
  };
  const history = selected('history', row => row.board === boardId);
  const input = { version: 1, actor, boardId, queue, mac: {
    boards: selected('boards', row => row.id === boardId), objects: selected('objects', row => row.board === boardId), history,
    operations: selected('operations', row => ids.has(row.id)), board_creations: selected('board_creations', row => row.id === boardId),
    pen_jobs: selected('pen_jobs', row => row.board === boardId), assetHashes: mac.manifest.files.filter(f => f.path.startsWith('assets/')).map(f => f.path.slice(7)),
  } };
  const encoded = bytes(input); check(encoded.length <= LIMIT, 'This board history exceeds the reconciliation bound. Retain both snapshots.');
  let report;
  try { report = JSON.parse(execFileSync('python3', ['-B', script], { input: encoded, encoding: 'utf8', timeout: 30000, maxBuffer: LIMIT, stdio: ['pipe', 'pipe', 'pipe'] })); }
  catch (error) { throw legacyError(error.code === 'ENOENT' ? 'Python 3 with its standard library is required for exact historical number semantics.'
    : String(error.stderr || 'The bounded reconciliation did not complete.').trim().slice(0, 600)); }
  check(report.version === 1 && report.boardId === boardId && report.actor === actor && report.accepted === false && report.legacyQueueChanged === false,
    'Invalid reconciliation helper result.');
  const source = { android: android.manifest.revision, mac: mac.manifest.revision, boardId, actor };
  const summary = { version: 1, kind: 'lisiere-reconciliation', source, operations: report.operations, revisionMapping: report.revisionMapping,
    blocked: report.blocked, canonicalRevision: report.canonicalRevision, projectedRevision: report.board?.revision ?? null,
    accepted: false, legacyQueueChanged: false, effect: report.effect };
  const selectedIds = new Set(report.operations.filter(row => row.selected).map(row => row.id));
  return { summary, report, android, mac, original: {
    version: 1, source, mac: { ...input.mac, operations: input.mac.operations.filter(row => selectedIds.has(row.id)) },
    queue: queue.filter(entry => report.selectedSeqs.includes(String(entry.row.seq?.integer ?? entry.row.seq))),
  } };
}

function prepare(root, options, canWrite) {
  const rootIdentity = canonicalNotebookRoot(root);
  const inspected = inspectLisiereReconciliation(options), { summary, report, mac, android, original } = inspected;
  const identity = { version: 1, rootIdentity, source: summary.source, path: options.path, reportHash: notebookHash(summary) };
  const requestId = 'reconcile-' + notebookHash(identity), recovery = `${STORE}/${requestId}`;
  const configuration = config(root);
  let converted, input, current, conversionError;
  if (!summary.blocked) {
    try {
      converted = convertLisiereBoard(report.board, report.objects, hash => {
        if (Object.hasOwn(report.assets, hash)) {
          const raw = Buffer.from(report.assets[hash], 'base64'); check(notebookHash(raw) === hash, 'Recovered asset content address changed.'); return raw;
        }
        return mac.asset(hash);
      });
      // A combined recovery is a new working scene, not a replacement for a
      // canonical notebook previously imported or edited at another location.
      converted.document.id = 'reconciled-' + notebookHash(summary.source).slice(0, 64);
      input = { document: converted.document, tombstones: converted.tombstones, path: options.path, requestId,
        sourceRevision: notebookHash(summary.source) };
      encodeNotebook(input.document);
      current = importNotebookDraft(root, input, { canWrite, preview: true });
    } catch (error) { conversionError = { code: error.code || 'lisiere_recovery_conflict', message: error.message }; }
  }
  const revision = notebookHash({ identity, configuration, conversion: converted ? notebookHash(encodeNotebook(converted.document)) : null });
  return { rootIdentity, configuration, revision, identity, recovery, input, current, original, inspected,
    summary: { ...summary, revision, recovery, path: options.path, requestId, resourceId: input?.document.id ?? null,
      blocked: summary.blocked || Boolean(conversionError), ...(conversionError ? { conversionError } : {}),
      idMapping: converted?.idMapping || [], imported: Boolean(current?.replayed), applied: false } };
}

/** Import only a conflict-free, explicitly previewed projection into working state.
 * Per-file and terminal review remain the existing human-owned operations. */
export function migrateLisiereReconciliation(root, options, { canWrite = () => false, beforeWrite = () => {}, checkpoint = () => {} } = {}) {
  const prepared = prepare(root, options, canWrite);
  if (!options.apply) return prepared.summary;
  check(options.expectedRevision === prepared.revision, 'The sources, destination or permissions changed after reconciliation preview.');
  check(!prepared.summary.blocked, 'Unresolved operations or destination conflicts remain. Inspect the complete plan; no queue was replayed and no work was overwritten.');
  return withNotebookLock(root, `${STORE}/migration.lock`, () => {
    const { identity, input, recovery, original, inspected } = prepared;
    const recheck = () => {
      check(canonicalNotebookRoot(root) === prepared.rootIdentity && config(root) === prepared.configuration && canWrite(options.path), 'The exact project or permission changed.');
      for (const archive of [inspected.android, inspected.mac]) {
        const raw = readNotebookBytes(archive.directory, 'manifest.json', 8 * 1024 * 1024);
        check(raw && JSON.parse(raw).revision === archive.manifest.revision, 'The original snapshot changed during reconciliation.');
      }
    };
    recheck(); importNotebookDraft(root, input, { canWrite, preview: true }); beforeWrite(); recheck();
    retainLisiereRecoveryBytes(root, `${recovery}/plan.json`, bytes({ identity, revision: prepared.revision }));
    const originalBytes = bytes(original);
    check(originalBytes.length <= 32 * 1024 * 1024, 'Selected original records exceed the bounded retained copy.');
    retainLisiereRecoveryBytes(root, `${recovery}/original-records.json`, originalBytes);
    retainLisiereRecoveryBytes(root, `${recovery}/mapping.json`, bytes({ idMapping: prepared.summary.idMapping, revisions: prepared.summary.revisionMapping }));
    checkpoint('backed-up'); recheck();
    const result = importNotebookDraft(root, input, { canWrite }); checkpoint('imported');
    retainLisiereRecoveryBytes(root, `${recovery}/applied.json`, bytes({ version: 1, requestId: input.requestId, source: identity.source, resourceId: result.resourceId, accepted: false }));
    return { ...prepared.summary, applied: true, imported: true, replayed: result.replayed, currentRevision: result.revision, locator: result.locator };
  });
}
