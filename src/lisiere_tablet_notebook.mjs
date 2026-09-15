import { decodeLisiereObject, legacyError } from './lisiere_archive.mjs';
import { notebookHash, stableNotebookJson } from './notebook_io.mjs';
const check = (ok, message) => { if (!ok) throw legacyError(message); };
const cells = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
  Buffer.isBuffer(value) ? { base64: value.toString('base64') } : typeof value === 'bigint' ? { integer: String(value) } : value]));

export function retainedTabletBoard(archive, boardId) {
  let retainedBytes = 0;
  const select = (name, predicate, maxCount) => {
    const selected = [];
    for (const row of archive.rows(name)) if (predicate(row)) {
      retainedBytes += Buffer.byteLength(stableNotebookJson(cells(row)));
      check(retainedBytes <= 24 * 1024 * 1024 && selected.length < maxCount, 'The selected cache exceeds its count or byte bound.'); selected.push(row);
    }
    return selected;
  };
  const heads = select('board_headers', row => row.board === boardId, 1);
  const compact = select('cache', row => row.key === 'board:' + boardId, 1);
  if (!heads.length && !compact.length) return null;
  const rows = heads.length ? select('board_objects', row => row.board === boardId, 20000) : [];
  const header = decodeLisiereObject((heads[0] || compact[0]).value);
  check(header.id === boardId && (!header.objects || Array.isArray(header.objects)), 'The cached board identity is inconsistent.');
  const objects = heads.length ? rows.map(row => {
    const value = decodeLisiereObject(row.value); check(value.id === undefined || value.id === row.id, 'The cached object identity is inconsistent.');
    return { ...value, id: row.id };
  }) : (header.objects || []);
  check(objects.length <= 20000 && new Set(objects.map(object => object.id)).size === objects.length, 'The cached board has too many or duplicated objects.');
  const original = { headers: heads.map(cells), compact: compact.map(cells), objects: rows.map(cells) };
  check(Buffer.byteLength(stableNotebookJson(original)) <= 24 * 1024 * 1024, 'This retained cached board exceeds the bounded recovery copy.');
  return { header, objects, original, counts: { objects: objects.length, headers: heads.length, compact: compact.length },
    shadowedCompact: heads.length > 0 && compact.length > 0 };
}

/** A cached scene is a separately chosen recovery copy, never evidence that an
 * operation was delivered, or that a missing cache object was deleted on Mac. */
export function tabletCopyProjection(android, mac, boardId, actor = null) {
  const cached = retainedTabletBoard(android, boardId); check(cached, 'The selected board has no retained tablet view.');
  const mapping = [], objects = [];
  for (const value of cached.objects) {
    const { revision, ...content } = value;
    check(typeof value.id === 'string' && value.id && (revision === undefined || Number.isSafeInteger(revision) && revision >= 0), 'The cached object has an unsupported original revision.');
    mapping.push({ objectId: value.id, originalRevision: revision ?? null, importedRevision: 1,
      evidence: 'explicit-cache-copy-not-mac-receipt' });
    objects.push({ board: boardId, id: value.id, revision: 1, data: value.deleted === true ? null : JSON.stringify({ ...content, revision: 1 }) });
  }
  const assets = {}, retainedAssets = [];
  const wanted = new Set(cached.objects.filter(object => object.type === 'image').map(object => object.assetId));
  const wire = new Map([...android.androidArguments()].map(row => [row.seq, row]));
  for (const row of android.rows('outbox')) if (row.operation === 'asset.put') {
    let args; try { args = wire.has(String(row.seq)) ? JSON.parse(wire.get(String(row.seq)).argsJson) : decodeLisiereObject(row.args); } catch { continue; }
    if (typeof args.data !== 'string' || args.data.length > 28 * 1024 * 1024) continue;
    const bytes = Buffer.from(args.data, 'base64'); if (bytes.toString('base64') !== args.data) continue;
    const hash = notebookHash(bytes);
    if (wanted.has(hash)) { assets[hash] = args.data; retainedAssets.push(cells(row)); }
  }
  // Missing assets are refused by the converter; no placeholder raster or URL fetch.
  const source = { android: android.manifest.revision, mac: mac.manifest.revision, boardId, actor, recoveryView: 'tablet' };
  const header = cached.header, board = { id: boardId, title: header.title || 'Recovered tablet drawing', project: header.project ?? null,
    directory: header.directory ?? '', anchor: typeof header.anchor === 'object' ? JSON.stringify(header.anchor) : header.anchor ?? null, revision: 1 };
  const summary = { version: 1, kind: 'lisiere-reconciliation', recoveryView: 'tablet', source, operations: [], revisionMapping: mapping,
    cachedView: cached.counts, shadowedCompactRetained: cached.shadowedCompact, canonicalRevision: null, projectedRevision: 1,
    blocked: false, accepted: false, legacyQueueChanged: false, delivery: 'not-inferred', omissionsAreNotMacDeletions: true,
    effect: 'separate-editable-tablet-cache-copy-only' };
  return { android, mac, summary, report: { board, objects, assets }, original: { version: 1, source, cached: cached.original, assets: retainedAssets } };
}
