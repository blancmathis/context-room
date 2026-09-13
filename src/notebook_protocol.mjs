/** Portable visual document and targeted edit contract; no review authority. */
export const NOTEBOOK_VERSION = 1;
export const NOTEBOOK_MIME = 'application/vnd.context-room.notebook+json';
export const NOTEBOOK_LIMITS = Object.freeze({ bytes: 20 * 1024 * 1024, objects: 20000, edits: 256, points: 16384, text: 100000, assets: 128 });
export function notebookError(code, message, details) {
  return Object.assign(new Error(message), { code, statusCode: /conflict|stale|recovery/.test(code) ? 409 : /scope|authority/.test(code) ? 403 : 400, ...(details ? { details } : {}) });
}
export function failNotebook(code, message, details) { throw notebookError(code, message, details); }
const plain = v => v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
export function notebookId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) failNotebook('notebook_id', 'Invalid notebook or operation identifier.');
  return value;
}
export function notebookPath(value) {
  if (typeof value !== 'string' || !value.endsWith('.crnb') || value.length > 1024 || value.includes('\\') || /[\x00-\x1f]/.test(value)
    || value.split('/').some(p => !p || p.startsWith('.') || p === 'node_modules')) failNotebook('notebook_path', 'Choose an ordinary relative .crnb file path.');
  return value;
}
const numeric = (value, fallback = 0, max = 1e7) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > max) failNotebook('notebook_number', 'Coordinates must be finite and bounded.');
  return value;
};
export const cloneNotebook = value => JSON.parse(JSON.stringify(value));
export function notebookActor(value) {
  if (!plain(value) || !['human', 'agent', 'import'].includes(value.kind)) failNotebook('notebook_actor', 'A scoped author is required.');
  return { kind: value.kind, id: notebookId(value.id), ...(value.deviceId ? { deviceId: notebookId(value.deviceId) } : {}), ...(value.sessionId ? { sessionId: notebookId(value.sessionId) } : {}) };
}
function points(value) {
  if (!Array.isArray(value) || !value.length || value.length > NOTEBOOK_LIMITS.points) failNotebook('notebook_points', 'A stroke needs 1–16384 points. Use segments for long gestures.');
  return value.map(p => {
    if (!Array.isArray(p) || p.length < 2 || p.length > 4) failNotebook('notebook_points', 'Invalid stroke point.');
    return [numeric(p[0]), numeric(p[1]), Math.max(0, Math.min(1, numeric(p[2], .5, 1))), ...(p.length === 4 ? [numeric(p[3], 0, Number.MAX_SAFE_INTEGER)] : [])];
  });
}
export function normalizeNotebookObject(value, id = value?.id) {
  if (!plain(value) || !['ink', 'rect', 'ellipse', 'line', 'arrow', 'text', 'image', 'connector'].includes(value.type)) failNotebook('notebook_object', 'Unsupported visual object.');
  const result = { id: notebookId(id), type: value.type };
  for (const key of ['x', 'y', 'width', 'height', 'x2', 'y2', 'rotation', 'fontSize', 'strokeWidth']) if (value[key] !== undefined) result[key] = numeric(value[key]);
  for (const key of ['color', 'fill']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !/^(#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})|black|white|transparent|none)$/.test(value[key])) failNotebook('notebook_color', 'Use a plain color, not a resource URL.');
    result[key] = value[key];
  }
  if (value.locked !== undefined) { if (typeof value.locked !== 'boolean') failNotebook('notebook_object', 'Invalid object lock.'); result.locked = value.locked; }
  if (value.type === 'ink') result.points = points(value.points);
  if (value.type === 'text') {
    if (typeof value.text !== 'string' || value.text.length > NOTEBOOK_LIMITS.text) failNotebook('notebook_text', 'Text exceeds the notebook limit.');
    result.text = value.text;
  }
  if (value.type === 'image') {
    if (!/^[a-f0-9]{64}$/.test(value.asset || '')) failNotebook('notebook_asset', 'Images reference an embedded content-addressed asset.');
    result.asset = value.asset;
  }
  if (value.type === 'connector') for (const key of ['from', 'to']) result[key] = notebookId(value[key]);
  return result;
}
export function normalizeNotebookDocument(input) {
  if (!plain(input) || input.schemaVersion !== NOTEBOOK_VERSION || input.mediaType !== NOTEBOOK_MIME) failNotebook('notebook_version', 'Unsupported notebook version; the original is unchanged.');
  if (!Array.isArray(input.objects) || input.objects.length > NOTEBOOK_LIMITS.objects) failNotebook('notebook_objects', 'Notebook object limit exceeded.');
  const ids = new Set(), objects = input.objects.map(object => {
    const clean = normalizeNotebookObject(object);
    if (ids.has(clean.id)) failNotebook('notebook_object', 'Duplicate object id.');
    ids.add(clean.id);
    if (!Number.isSafeInteger(object.revision) || object.revision < 1) failNotebook('notebook_revision', 'Invalid object revision.');
    return { ...clean, revision: object.revision, createdBy: notebookActor(object.createdBy), updatedBy: notebookActor(object.updatedBy) };
  });
  const assets = {};
  if (!plain(input.assets || {}) || Object.keys(input.assets || {}).length > NOTEBOOK_LIMITS.assets) failNotebook('notebook_asset', 'Too many notebook assets.');
  for (const [hash, asset] of Object.entries(input.assets || {})) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !plain(asset) || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType) || typeof asset.data !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) failNotebook('notebook_asset', 'Invalid embedded image.');
    assets[hash] = { mimeType: asset.mimeType, data: asset.data };
  }
  for (const object of objects) if (object.type === 'image' && !Object.hasOwn(assets, object.asset)) failNotebook('notebook_asset', 'A notebook image is missing.');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) failNotebook('notebook_revision', 'Invalid scene revision.');
  const title = String(input.title || 'Notebook');
  if (title.length > 240) failNotebook('notebook_title', 'Notebook title is too long.');
  return { schemaVersion: NOTEBOOK_VERSION, mediaType: NOTEBOOK_MIME, id: notebookId(input.id), title, revision: input.revision, objects, assets };
}
export const emptyNotebook = (id, title = 'Notebook') => normalizeNotebookDocument({ schemaVersion: NOTEBOOK_VERSION, mediaType: NOTEBOOK_MIME, id, title, revision: 0, objects: [], assets: {} });
/** A batch compares exact object revisions, not an obsolete whole-scene snapshot. */
export function applyNotebookEdits(document, tombstones, edits, actor, { origins = {} } = {}) {
  actor = notebookActor(actor);
  if (!Array.isArray(edits) || !edits.length || edits.length > NOTEBOOK_LIMITS.edits) failNotebook('notebook_edits', 'A batch needs 1–256 targeted edits.');
  const current = new Map(document.objects.map(o => [o.id, o])), seen = new Set(), changes = [], conflicts = [];
  for (const edit of edits) {
    if (!plain(edit)) failNotebook('notebook_edit', 'Invalid edit.');
    const id = notebookId(edit.id), before = current.get(id) || null;
    if (seen.has(id)) failNotebook('notebook_edit', 'An object may occur only once in a batch.');
    seen.add(id);
    if (!Number.isSafeInteger(edit.expectedRevision) || edit.expectedRevision < 0) failNotebook('notebook_revision', 'Each edit needs an exact object revision.');
    const revision = before?.revision || tombstones[id] || 0;
    if (revision !== edit.expectedRevision) { conflicts.push({ id, expectedRevision: edit.expectedRevision, actualRevision: revision, current: before }); continue; }
    if (before?.locked && !(edit.kind === 'patch' && Object.keys(edit.patch || {}).length === 1 && edit.patch.locked === false)) failNotebook('notebook_locked_conflict', 'Unlock the object explicitly before editing it.', { id });
    let after = null;
    if (edit.kind === 'delete') { if (!before) failNotebook('notebook_missing_conflict', 'The object has already been removed.', { id }); }
    else if (edit.kind === 'put') after = normalizeNotebookObject(edit.object, id);
    else if (edit.kind === 'patch') {
      if (!before || !plain(edit.patch) || ['id', 'revision', 'createdBy', 'updatedBy', 'type'].some(k => Object.hasOwn(edit.patch, k))) failNotebook('notebook_patch', 'Patch an existing object without changing its identity or authorship.');
      after = normalizeNotebookObject({ ...before, ...edit.patch }, id);
    } else if (edit.kind === 'append') {
      if (!before || before.type !== 'ink') failNotebook('notebook_append', 'Append only to an existing stroke.');
      if (actor.kind !== before.createdBy.kind || actor.id !== before.createdBy.id) failNotebook('notebook_authority', 'Only the stroke author can extend its moving tip.');
      after = normalizeNotebookObject({ ...before, points: [...before.points, ...points(edit.points)] }, id);
    } else failNotebook('notebook_edit', 'Unsupported notebook operation.');
    if (after?.type === 'image' && !Object.hasOwn(document.assets, after.asset)) failNotebook('notebook_asset', 'Upload the exact image before referencing it.');
    if (after) after = { ...after, revision: revision + 1, createdBy: before?.createdBy || origins[id] || actor, updatedBy: actor };
    changes.push({ id, before, after, revision: revision + 1 });
  }
  if (conflicts.length) failNotebook('notebook_object_conflict', 'Some objects changed. Your local work is retained for reconciliation.', { conflicts });
  for (const change of changes) { if (change.after) current.set(change.id, change.after); else current.delete(change.id); }
  if (current.size > NOTEBOOK_LIMITS.objects) failNotebook('notebook_objects', 'Notebook object limit exceeded.');
  return { document: { ...document, revision: document.revision + 1, objects: [...current.values()] }, changes };
}
