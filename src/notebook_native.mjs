/** Presentation adapter for the retained Android canvas. Storage and authority stay in
 * NotebookClient / the Mac protocol. The complete canonical object survives a native edit. */
import { cloneNotebook, normalizeNotebookObject, notebookId } from './notebook_protocol.mjs';

export function notebookNativeObject(object, order = 0) {
  const item = cloneNotebook(object), type = item.type;
  const fontSize = item.fontSize || 18;
  return { ...item, canonical: cloneNotebook(item), z: order,
    x: item.x || 0, y: (item.y || 0) - (type === 'text' ? fontSize : 0),
    w: ['line', 'arrow'].includes(type) ? (item.x2 ?? ((item.x || 0) + (item.width ?? 140))) - (item.x || 0)
      : item.width ?? (type === 'text' ? Math.max(...item.text.split('\n').map(line => line.length), 1) * fontSize * .65 : 140),
    h: ['line', 'arrow'].includes(type) ? (item.y2 ?? ((item.y || 0) + (item.height ?? 80))) - (item.y || 0)
      : item.height ?? (type === 'text' ? item.text.split('\n').length * fontSize * (item.lineHeight || 1.3) : 80),
    width: item.strokeWidth ?? 2,
    ...(type === 'text' ? { fontSize } : {}),
    ...(type === 'image' ? { assetId: item.asset } : {}) };
}

export function notebookObjectFromNative(value, id = value.id) {
  const object = { ...(value.canonical || {}), id, type: value.type };
  const baseline = value.canonical ? notebookNativeObject(value.canonical) : null;
  const changed = key => Object.hasOwn(value, key) && (!baseline || JSON.stringify(value[key]) !== JSON.stringify(baseline[key]));
  for (const key of ['x', 'rotation', 'fontSize', 'lineHeight', 'text', 'locked', 'color', 'fill', 'from', 'to', 'fromSide', 'toSide', 'route', 'routeOffset']) {
    if (changed(key)) object[key] = value[key];
  }
  if (changed('y')) object.y = value.y + (value.type === 'text' ? value.fontSize || 18 : 0);
  if (changed('width')) object.strokeWidth = value.width;
  if (value.type === 'ink') { if (changed('points')) object.points = cloneNotebook(value.points); if (changed('pressureCurve')) object.pressureCurve = value.pressureCurve; }
  else if (['line', 'arrow'].includes(value.type)) {
    if (changed('x') || changed('w')) object.x2 = (value.x || 0) + (value.w || 0);
    if (changed('y') || changed('h')) object.y2 = (value.y || 0) + (value.h || 0);
  } else { if (changed('w')) object.width = value.w; if (changed('h')) object.height = value.h; }
  if (value.type === 'image' && changed('assetId')) object.asset = value.assetId;
  return normalizeNotebookObject(object, id);
}

export function notebookNativeEdits(operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 256) throw new Error('A native command needs 1–256 targeted edits.');
  return operations.map(op => {
    const id = notebookId(op.id);
    if (op.kind === 'append') return { kind: 'append', id, expectedRevision: op.expectedRevision, points: cloneNotebook(op.points) };
    return op.value == null ? { kind: 'delete', id, expectedRevision: op.expectedRevision }
      : { kind: 'put', id, expectedRevision: op.expectedRevision, object: notebookObjectFromNative(op.value, id) };
  });
}
