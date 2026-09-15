import { readLisiereSnapshot, decodeLisiereObject, legacyError } from './lisiere_archive.mjs';
import { notebookHash } from './notebook_io.mjs';

const KINDS = ['projects', 'boards', 'drafts', 'conversations', 'operations', 'recordings'];
const display = value => typeof value === 'bigint' ? String(value) : typeof value === 'string' ? value.slice(0, 4096) : value ?? null;
export function lisiereRecordSelector(kind, row) {
  const cells = Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    Buffer.isBuffer(value) ? { base64: value.toString('base64') } : typeof value === 'bigint' ? { integer: String(value) } : value]));
  return notebookHash({ kind, cells });
}
function requireValue(value, message) { if (!value) throw legacyError(message); }

/** Describe retained records without exposing their full text, acknowledging
 * pending work, resolving a destination or starting a legacy runtime. */
export function inspectLisiereSnapshot(snapshot, { kind = 'all', limit = 50, cursor } = {}) {
  limit = Number(limit);
  requireValue((kind === 'all' || KINDS.includes(kind)) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 200,
    'Choose a recovery inventory kind and a page size between 1 and 200.');
  const archive = readLisiereSnapshot(snapshot); let offset = 0;
  if (cursor !== undefined) {
    requireValue(typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 512 && Buffer.from(cursor, 'base64url').toString('base64url') === cursor, 'Invalid recovery inventory cursor.');
    let token; try { token = JSON.parse(Buffer.from(cursor, 'base64url')); } catch { throw legacyError('Invalid recovery inventory cursor.'); }
    requireValue(token?.revision === archive.manifest.revision && token.kind === kind && Number.isSafeInteger(token.offset) && token.offset >= 0,
      'The recovery inventory cursor belongs to another snapshot or selection.'); offset = token.offset;
  }
  const items = [], counts = Object.fromEntries(KINDS.map(key => [key, 0])); let total = 0, otherCacheEntries = 0;
  const emit = (group, value) => {
    counts[group]++;
    if (kind !== 'all' && kind !== group) return;
    if (total >= offset && items.length < limit) items.push({ kind: group, ...value, accepted: false });
    total++;
  };
  const fields = (row, names) => Object.fromEntries(names.map(name => [name, display(row[name])]));
  const objectRecord = (group, row, raw, extra = {}) => {
    try { const value = decodeLisiereObject(raw); emit(group, { selector: lisiereRecordSelector(group, row), ...extra,
      ...fields(value, ['id', 'project', 'path', 'title', 'version', 'revision', 'epoch', 'state']), status: 'retained' }); }
    catch (error) { emit(group, { selector: lisiereRecordSelector(group, row), ...extra, status: 'needs-reconciliation', reason: String(error.message).slice(0, 600) }); }
  };
  if (archive.manifest.kind === 'mac-workspace') {
    for (const row of archive.rows('projects')) emit('projects', { selector: lisiereRecordSelector('projects', row), ...fields(row, ['id', 'name', 'root']) });
    for (const row of archive.rows('boards')) emit('boards', { selector: lisiereRecordSelector('boards', row), ...fields(row, ['id', 'title', 'project', 'directory', 'revision']) });
    for (const row of archive.rows('drafts')) emit('drafts', { selector: lisiereRecordSelector('drafts', row), ...fields(row, ['project', 'path', 'device', 'version']),
      characters: typeof row.content === 'string' ? row.content.length : null, baseKnown: typeof row.base === 'string' && row.base.length > 0, delivery: 'unconfirmed' });
    for (const row of archive.rows('conversations')) emit('conversations', { selector: lisiereRecordSelector('conversations', row), ...fields(row, ['id', 'project', 'thread', 'title']), status: 'retained-history' });
    for (const row of archive.rows('native_requests')) emit('operations', { selector: lisiereRecordSelector('native_requests', row), operation: 'native-request', ...fields(row, ['id', 'conversation', 'active']), delivery: 'needs-original-receipt' });
    for (const row of archive.rows('desktop_submissions')) emit('operations', { selector: lisiereRecordSelector('desktop_submissions', row), operation: 'desktop-submission', ...fields(row, ['id', 'project', 'thread', 'state']), delivery: 'needs-original-receipt' });
  } else {
    for (const row of archive.rows('board_headers')) objectRecord('boards', row, row.value, { boardId: display(row.board) });
    for (const row of archive.rows('cache')) {
      requireValue(typeof row.key === 'string', 'An Android cache entry has no original key.');
      if (/^(?:draftmeta|dirtydraft):/.test(row.key)) objectRecord('drafts', row, row.value, { sourceKey: row.key, delivery: 'unconfirmed' });
      else if (/^(?:draftdoc|agent-draft):/.test(row.key)) emit('drafts', { selector: lisiereRecordSelector('drafts', row), sourceKey: row.key,
        characters: typeof row.value === 'string' ? row.value.length : null, status: 'retained-text', delivery: 'unknown', requiresOriginalJournal: true });
      else if (/^conversation-meta:/.test(row.key)) objectRecord('conversations', row, row.value, { sourceKey: row.key });
      else if (/^(?:native-request|native-voice-draft):/.test(row.key)) objectRecord('operations', row, row.value, { sourceKey: row.key, delivery: 'needs-original-receipt' });
      else otherCacheEntries++;
    }
    for (const row of archive.rows('outbox')) {
      const base = { selector: lisiereRecordSelector('outbox', row), ...fields(row, ['id', 'seq', 'operation', 'error']), delivery: 'unconfirmed' };
      try { const args = decodeLisiereObject(row.args); emit('operations', { ...base, ...fields(args, ['board', 'project', 'path', 'operationId']) }); }
      catch (error) { emit('operations', { ...base, status: 'needs-reconciliation', reason: String(error.message).slice(0, 600) }); }
    }
  }
  for (const entry of archive.manifest.files.filter(entry => entry.path.startsWith('recordings/')))
    emit('recordings', { selector: lisiereRecordSelector('recordings', entry), name: entry.path.slice(11), bytes: entry.bytes, sha256: entry.sha256,
      durationSeconds: entry.bytes / 32000, context: 'unassigned' });
  const nextCursor = offset + items.length < total ? Buffer.from(JSON.stringify({ revision: archive.manifest.revision, kind, offset: offset + items.length })).toString('base64url') : null;
  return { version: 1, snapshotVersion: archive.manifest.version, snapshotKind: archive.manifest.kind, revision: archive.manifest.revision,
    accepted: false, counts, otherCacheEntries, tables: archive.manifest.tables.map(table => ({ name: table.name, rows: table.rows })),
    items, pagination: { limit, offset, total, nextCursor } };
}
