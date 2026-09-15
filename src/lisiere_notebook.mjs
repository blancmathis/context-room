import { notebookId, normalizeNotebookObject, normalizeNotebookDocument, NOTEBOOK_VERSION, NOTEBOOK_MIME, NOTEBOOK_LIMITS } from './notebook_protocol.mjs';
import { notebookHash } from './notebook_io.mjs';
import { encodeNotebook } from './notebooks.mjs';
import { decodeLisiereObject, legacyError } from './lisiere_archive.mjs';

function requireValue(condition, message) { if (!condition) throw legacyError(message); }
const legacyId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
function validId(value) { try { notebookId(value); return true; } catch { return false; } }
const number = (value, fallback) => {
  if (value === undefined) return fallback;
  requireValue(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7, 'A legacy object has invalid geometry.'); return value;
};

/** Convert the captured tablet presentation, retaining exact IDs or an explicit
 * mapping. The caller keeps the original recovery snapshot and history. */
export function convertLisiereBoard(board, rows, readAsset) {
  requireValue(board && legacyId(board.id) && Number.isSafeInteger(board.revision) && board.revision >= 0, 'A versioned legacy board is required.');
  requireValue(Array.isArray(rows) && rows.length <= NOTEBOOK_LIMITS.objects, 'This legacy board exceeds the notebook object limit. Retain the original snapshot.');
  const id = validId(board.id) ? board.id : `legacy-${notebookHash(['board', board.id])}`;
  const seen = new Set(), reserved = new Set(rows.map(row => row.id).filter(validId)), mapping = new Map();
  for (const row of rows) {
    requireValue(row.board === board.id && legacyId(row.id) && !seen.has(row.id) && Number.isSafeInteger(row.revision)
      && row.revision > 0 && row.revision <= board.revision, 'Legacy object identity or revision is inconsistent.');
    seen.add(row.id); let mapped = row.id;
    if (!validId(mapped)) {
      let attempt = 0; do { mapped = `legacy-${notebookHash(['object', board.id, row.id, attempt++])}`; } while (reserved.has(mapped));
      reserved.add(mapped);
    }
    mapping.set(row.id, mapped);
  }
  const actor = { kind: 'import', id }, assets = {}, tombstones = {}, idMapping = [], ordered = [], live = new Set();
  let convertedBytes = 0, assetCount = 0;
  for (const row of rows) if (row.data !== null) live.add(row.id);
  for (const [index, row] of rows.entries()) {
    const mapped = mapping.get(row.id); idMapping.push({ sourceId: row.id, objectId: mapped, revision: row.revision, deleted: row.data === null });
    if (row.data === null) { tombstones[mapped] = row.revision; continue; }
    const original = decodeLisiereObject(row.data), type = original.type;
    requireValue(['ink', 'rect', 'ellipse', 'arrow', 'connector', 'text', 'image'].includes(type)
      && (!Object.hasOwn(original, 'id') || original.id === row.id)
      && (!Object.hasOwn(original, 'revision') || original.revision === row.revision) && original.deleted !== true, 'A legacy object has conflicting identity or unsupported content.');
    const object = { id: mapped, type, color: '#000000', strokeWidth: number(original.width, 2), revision: row.revision, createdBy: actor, updatedBy: actor };
    requireValue(object.strokeWidth > 0, 'A legacy stroke width cannot be imported without changing its appearance.');
    if (original.locked !== undefined) { requireValue(typeof original.locked === 'boolean', 'A legacy object lock is invalid.'); object.locked = original.locked; }
    if (type === 'ink') {
      requireValue(Array.isArray(original.points) && original.points.length > 0 && original.points.length <= NOTEBOOK_LIMITS.points, 'This legacy stroke exceeds the editable point limit. Its original points remain in the recovery snapshot.');
      object.pressureCurve = 'linear';
      object.points = original.points.map(point => {
        requireValue(Array.isArray(point) && point.length >= 2 && point.length <= 4, 'A legacy stroke contains unsupported point channels.');
        // Legacy pen rendering defaults absent pressure to one; preserve every
        // supplied pressure/time value instead of remapping the samples.
        return [point[0], point[1], point[2] ?? 1, ...(point.length === 4 ? [point[3]] : [])];
      });
    } else {
      const x = number(original.x, 0), y = number(original.y, 0), w = number(original.w, 160), h = number(original.h, 60);
      if (type === 'arrow') Object.assign(object, { x, y, x2: x + number(original.w, 0), y2: y + number(original.h, 0) });
      else if (type === 'connector') {
        requireValue(live.has(original.from) && live.has(original.to), 'A legacy connector has a missing or deleted endpoint. Reconcile it from the retained source before import.');
        Object.assign(object, { from: mapping.get(original.from), to: mapping.get(original.to) });
        for (const key of ['fromSide', 'toSide']) if (['left', 'right', 'top', 'bottom', 'center'].includes(original[key])) object[key] = original[key];
        if (original.route === 'outside-left') { object.route = 'outside-left'; object.routeOffset = number(original.routeOffset, 48); }
      } else if (type === 'text') {
        const font = number(original.fontSize, 22); requireValue(font >= 8, 'This legacy text size is outside the supported rendering range.');
        Object.assign(object, { x: Math.min(x, x + w), y: Math.min(y, y + h) + font, width: Math.abs(w), height: Math.abs(h), fontSize: font, lineHeight: 1.4, text: original.text ?? '' });
      } else if (type === 'image') {
        const hash = original.assetId; requireValue(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && typeof readAsset === 'function', 'A legacy image needs its exact recovery asset.');
        if (!Object.hasOwn(assets, hash)) {
          requireValue(++assetCount <= NOTEBOOK_LIMITS.assets, 'This legacy board exceeds the embedded image count limit.');
          const data = readAsset(hash); requireValue(Buffer.isBuffer(data) && notebookHash(data) === hash, 'A legacy image asset changed after export.');
          convertedBytes += 4 * Math.ceil(data.length / 3);
          requireValue(convertedBytes <= NOTEBOOK_LIMITS.bytes, 'The converted notebook exceeds its bounded editable file size.');
          const mimeType = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
            : data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
            : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
          requireValue(mimeType, 'This legacy image format requires explicit conversion. Its original bytes remain in the recovery snapshot.');
          assets[hash] = { mimeType, data: data.toString('base64') };
        }
        Object.assign(object, { x: Math.min(x, x + w), y: Math.min(y, y + h), width: Math.abs(w), height: Math.abs(h), asset: hash });
      } else Object.assign(object, { x, y, width: w, height: h });
    }
    const clean = { ...normalizeNotebookObject(object), revision: row.revision, createdBy: actor, updatedBy: actor };
    convertedBytes += Buffer.byteLength(JSON.stringify(clean));
    requireValue(convertedBytes <= NOTEBOOK_LIMITS.bytes, 'The converted notebook exceeds its bounded editable file size.');
    ordered.push({ object: clean, z: number(original.z, 0), index });
  }
  // Cyclic connector references cannot be reconstructed as attached geometry.
  const byId = new Map(ordered.map(entry => [entry.object.id, entry.object])), complete = new Set();
  function check(id, visiting = new Set()) {
    if (complete.has(id)) return; const object = byId.get(id); if (object?.type !== 'connector') { complete.add(id); return; }
    requireValue(!visiting.has(id) && visiting.size < 64, 'The legacy connector graph is cyclic or too deep to import.');
    const next = new Set([...visiting, id]); check(object.from, next); check(object.to, next); complete.add(id);
  }
  for (const id of byId.keys()) check(id);
  const document = normalizeNotebookDocument({ schemaVersion: NOTEBOOK_VERSION, mediaType: NOTEBOOK_MIME, id, title: board.title || 'Notebook', revision: board.revision,
    objects: ordered.sort((a, b) => a.z - b.z || a.index - b.index).map(entry => entry.object), assets });
  encodeNotebook(document);
  return { document, tombstones, idMapping, source: { boardId: board.id, revision: board.revision, project: board.project ?? null, directory: board.directory ?? null, anchor: board.anchor ?? null }, accepted: false };
}
