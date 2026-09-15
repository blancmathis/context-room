/** Shared deterministic geometry; no browser, provider, or filesystem dependency. */
import { notebookInkRadius } from './notebook_ink.mjs';
export function notebookObjectBounds(object, objects = []) {
  const byId = objects instanceof Map ? objects : new Map(objects.map(item => [item.id, item]));
  let samples;
  if (object.type === 'ink') samples = object.points;
  else if (object.type === 'connector') {
    samples = notebookConnectorRoute(object, byId);
  } else {
    const x = object.x || 0, y = object.y || 0;
    const width = object.width ?? (object.type === 'text' ? Math.max(...object.text.split('\n').map(line => line.length), 1) * (object.fontSize || 18) * .65 : 140);
    const height = object.height ?? (object.type === 'text' ? object.text.split('\n').length * (object.fontSize || 18) * (object.lineHeight || 1.3) : 80);
    samples = [[x, y], [object.x2 ?? x + width, object.y2 ?? y + height]];
    if (object.type === 'text') samples = [[x, y - (object.fontSize || 18)], [x + width, y + height - (object.fontSize || 18)]];
  }
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [x, y] of samples) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  if (!Number.isFinite(left)) return { x: 0, y: 0, width: 0, height: 0 };
  const margin = Math.max(.5, object.strokeWidth || 2) / 2;
  if (object.rotation) {
    const cx = (object.x || 0) + (object.width ?? 140) / 2, cy = (object.y || 0) + (object.height ?? 80) / 2;
    const angle = object.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const corners = [[left, top], [right, top], [left, bottom], [right, bottom]].map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]);
    left = Math.min(...corners.map(p => p[0])); right = Math.max(...corners.map(p => p[0])); top = Math.min(...corners.map(p => p[1])); bottom = Math.max(...corners.map(p => p[1]));
  }
  return { x: left - margin, y: top - margin, width: right - left + 2 * margin, height: bottom - top + 2 * margin };
}
export const center = object => [(object.x || 0) + (object.width ?? 140) / 2, (object.y || 0) + (object.height ?? 80) / 2];
/** Logical attachment boxes match the native canvas; rotation does not retarget a port. */
export function notebookConnectorRoute(object, objects, visiting = new Set(), memo = new Map()) {
  const byId = objects instanceof Map ? objects : new Map(objects.map(item => [item.id, item]));
  if (memo.has(object.id)) return memo.get(object.id);
  if (visiting.has(object.id) || visiting.size >= 64) return [];
  const a = byId.get(object.from), b = byId.get(object.to); if (!a || !b) return [];
  const next = new Set([...visiting, object.id]);
  function box(item) {
    if (item.type === 'connector') {
      const points = notebookConnectorRoute(item, byId, next, memo); if (!points.length) return null;
      const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
      return [Math.min(...xs) - 12, Math.min(...ys) - 12, Math.max(...xs) + 12, Math.max(...ys) + 12];
    }
    if (item.type === 'ink') {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, radius = 3;
      for (const point of item.points) { const [x, y] = point; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); radius = Math.max(radius, notebookInkRadius(point, item.strokeWidth || 2, item.pressureCurve)); }
      return [left - radius, top - radius, right + radius, bottom + radius];
    }
    const font = item.fontSize || 18, x = item.x || 0, y = (item.y || 0) - (item.type === 'text' ? font : 0);
    const w = item.width ?? (item.type === 'text' ? Math.max(...item.text.split('\n').map(line => line.length), 1) * font * .65 : 140);
    const h = item.height ?? (item.type === 'text' ? item.text.split('\n').length * font * (item.lineHeight || 1.3) : 80);
    const x2 = item.x2 ?? x + w, y2 = item.y2 ?? y + h;
    return [Math.min(x, x2), Math.min(y, y2), Math.max(x, x2), Math.max(y, y2)];
  }
  function port(bounds, side) {
    const [left, top, right, bottom] = bounds, cx = (left + right) / 2, cy = (top + bottom) / 2;
    const ports = { left: [left, cy], right: [right, cy], top: [cx, top], bottom: [cx, bottom] };
    return Object.hasOwn(ports, side) ? ports[side] : [cx, cy];
  }
  const fromBox = box(a), toBox = box(b); if (!fromBox || !toBox) { memo.set(object.id, []); return []; }
  const from = port(fromBox, object.fromSide), to = port(toBox, object.toSide);
  if (object.route !== 'outside-left') { const route = [from, to]; memo.set(object.id, route); return route; }
  const lane = Math.min(from[0], to[0]) - (object.routeOffset || 48);
  const route = [from, [lane, from[1]], [lane, to[1]], to]; memo.set(object.id, route); return route;
}
export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function notebookHit(document, point, tolerance = 6) {
  const objects = new Map(document.objects.map(object => [object.id, object]));
  for (let i = document.objects.length - 1; i >= 0; i--) {
    const object = document.objects[i], b = notebookObjectBounds(object, objects);
    if (point[0] >= b.x - tolerance && point[0] <= b.x + b.width + tolerance && point[1] >= b.y - tolerance && point[1] <= b.y + b.height + tolerance) {
      if (object.type !== 'ink' || object.points.some((p, index) => {
        const a = object.points[Math.max(0, index - 1)], dx = p[0] - a[0], dy = p[1] - a[1], norm = dx * dx + dy * dy;
        const t = norm ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / norm)) : 0;
        return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy) <= tolerance + (object.strokeWidth || 2);
      })) return object;
    }
  }
  return null;
}
export function translateNotebookObject(object, dx, dy) {
  if (object.type === 'ink') return { points: object.points.map(([x, y, ...rest]) => [x + dx, y + dy, ...rest]) };
  if (object.type === 'connector') return {};
  return { x: (object.x || 0) + dx, y: (object.y || 0) + dy, ...(object.x2 !== undefined ? { x2: object.x2 + dx } : {}), ...(object.y2 !== undefined ? { y2: object.y2 + dy } : {}) };
}
export function notebookSceneBounds(document) {
  if (!document.objects.length) return { x: 0, y: 0, width: 1200, height: 900 };
  const objects = new Map(document.objects.map(object => [object.id, object]));
  const all = document.objects.map(o => notebookObjectBounds(o, objects));
  const x = Math.min(...all.map(b => b.x)) - 24, y = Math.min(...all.map(b => b.y)) - 24;
  return { x, y, width: Math.max(64, Math.max(...all.map(b => b.x + b.width)) - x + 24), height: Math.max(64, Math.max(...all.map(b => b.y + b.height)) - y + 24) };
}
