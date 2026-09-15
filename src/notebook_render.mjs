import { notebookInkOutline, notebookInkRadius } from './notebook_ink.mjs';
import { normalizeNotebookDocument } from './notebook_protocol.mjs';
import { notebookSceneBounds, notebookConnectorRoute } from './notebook_geometry.mjs';
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
export function notebookBounds(document) {
  const bounds = notebookSceneBounds(document), x = Math.min(0, bounds.x), y = Math.min(0, bounds.y);
  return { x, y, width: Math.max(1200, bounds.x + bounds.width) - x, height: Math.max(900, bounds.y + bounds.height) - y };
}
/** Deterministic, inert export of this exact scene. No provider calls or external resources. */
export function notebookSvg(input, { showOrigins = false } = {}) {
  const document = normalizeNotebookDocument(input), objects = new Map(document.objects.map(o => [o.id, o])), bounds = notebookBounds(document);
  const items = document.objects.map(o => {
    const x = o.x || 0, y = o.y || 0, w = o.width ?? 140, h = o.height ?? 80;
    const style = `stroke="${xml(o.color || '#222222')}" stroke-width="${Math.max(.1, o.strokeWidth || 2)}" stroke-linecap="round" stroke-linejoin="round" fill="${xml(o.fill || 'none')}"`;
    let body;
    if (o.type === 'ink') {
      const outline = notebookInkOutline(o.points, o.strokeWidth || 2, o.pressureCurve);
      body = `<polygon points="${outline.map(p => p.join(',')).join(' ')}" fill="${xml(o.color || '#222222')}"/>`;
      for (const p of [o.points[0], o.points.at(-1)]) body += `<circle cx="${p[0]}" cy="${p[1]}" r="${notebookInkRadius(p, o.strokeWidth || 2, o.pressureCurve)}" fill="${xml(o.color || '#222222')}"/>`;
    }
    else if (o.type === 'rect') body = `<rect x="${Math.min(x, x + w)}" y="${Math.min(y, y + h)}" width="${Math.abs(w)}" height="${Math.abs(h)}" ${style}/>`;
    else if (o.type === 'ellipse') body = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${Math.abs(w / 2)}" ry="${Math.abs(h / 2)}" ${style}/>`;
    else if (o.type === 'text') body = `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${Math.max(8, o.fontSize || 18)}" fill="${xml(o.color || '#222222')}">${o.text.split('\n').map((s, i) => `<tspan x="${x}" dy="${i ? `${o.lineHeight || 1.3}em` : 0}">${xml(s)}</tspan>`).join('')}</text>`;
    else if (o.type === 'image') { const a = document.assets[o.asset]; body = `<image x="${x}" y="${y}" width="${Math.abs(w)}" height="${Math.abs(h)}" href="data:${a.mimeType};base64,${a.data}"/>`; }
    else {
      let x1 = x, y1 = y, x2 = o.x2 ?? x + w, y2 = o.y2 ?? y + h;
      const route = o.type === 'connector' ? notebookConnectorRoute(o, objects) : [[x1, y1], [x2, y2]];
      if (!route.length) return '';
      [x1, y1] = route.at(-2); [x2, y2] = route.at(-1);
      body = `<path d="${route.map(([px, py], i) => `${i ? 'L' : 'M'}${px} ${py}`).join(' ')}" ${style}/>`;
      if (o.type !== 'line') { const a = Math.atan2(y2 - y1, x2 - x1), size = 12; body += `<path d="M${x2 - size * Math.cos(a - .45)} ${y2 - size * Math.sin(a - .45)} L${x2} ${y2} L${x2 - size * Math.cos(a + .45)} ${y2 - size * Math.sin(a + .45)}" ${style}/>`; }
    }
    const transform = o.rotation ? ` transform="rotate(${o.rotation} ${x + w / 2} ${y + h / 2})"` : '';
    return `<g data-object-id="${o.id}"${transform}><title>${xml(o.type)} · ${xml(o.createdBy.kind)}; changed by ${xml(o.updatedBy.kind)} · r${o.revision}</title>${body}${showOrigins && (o.createdBy.kind === 'agent' || o.updatedBy.kind === 'agent') ? `<text x="${x}" y="${y - 8}" font-family="sans-serif" font-size="11" fill="#555555">agent</text>` : ''}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" role="img" aria-label="${xml(document.title)}"><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="white"/>${items}</svg>`;
}
