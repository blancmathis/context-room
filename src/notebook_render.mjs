import { notebookInkOutline, notebookInkRadius } from './notebook_ink.mjs';
import { normalizeNotebookDocument } from './notebook_protocol.mjs';
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
export function notebookBounds(document) {
  let left = 0, top = 0, right = 1200, bottom = 900;
  for (const o of document.objects) {
    const samples = o.type === 'ink' ? o.points : [[o.x || 0, o.y || 0], [o.x2 ?? (o.x || 0) + (o.width || 140), o.y2 ?? (o.y || 0) + (o.height || 80)]];
    for (const p of samples) { left = Math.min(left, p[0] - 24); top = Math.min(top, p[1] - 24); right = Math.max(right, p[0] + 24); bottom = Math.max(bottom, p[1] + 24); }
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
/** Deterministic, inert export of this exact scene. No provider calls or external resources. */
export function notebookSvg(input, { showOrigins = false } = {}) {
  const document = normalizeNotebookDocument(input), objects = new Map(document.objects.map(o => [o.id, o])), bounds = notebookBounds(document);
  const items = document.objects.map(o => {
    const x = o.x || 0, y = o.y || 0, w = o.width ?? 140, h = o.height ?? 80;
    const style = `stroke="${xml(o.color || '#222222')}" stroke-width="${Math.max(.1, o.strokeWidth || 2)}" stroke-linecap="round" stroke-linejoin="round" fill="${xml(o.fill || 'none')}"`;
    let body;
    if (o.type === 'ink') {
      const outline = notebookInkOutline(o.points, o.strokeWidth || 2);
      body = `<polygon points="${outline.map(p => p.join(',')).join(' ')}" fill="${xml(o.color || '#222222')}"/>`;
      for (const p of [o.points[0], o.points.at(-1)]) body += `<circle cx="${p[0]}" cy="${p[1]}" r="${notebookInkRadius(p, o.strokeWidth || 2)}" fill="${xml(o.color || '#222222')}"/>`;
    }
    else if (o.type === 'rect') body = `<rect x="${Math.min(x, x + w)}" y="${Math.min(y, y + h)}" width="${Math.abs(w)}" height="${Math.abs(h)}" ${style}/>`;
    else if (o.type === 'ellipse') body = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${Math.abs(w / 2)}" ry="${Math.abs(h / 2)}" ${style}/>`;
    else if (o.type === 'text') body = `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${Math.max(8, o.fontSize || 18)}" fill="${xml(o.color || '#222222')}">${o.text.split('\n').map((s, i) => `<tspan x="${x}" dy="${i ? '1.3em' : 0}">${xml(s)}</tspan>`).join('')}</text>`;
    else if (o.type === 'image') { const a = document.assets[o.asset]; body = `<image x="${x}" y="${y}" width="${Math.abs(w)}" height="${Math.abs(h)}" href="data:${a.mimeType};base64,${a.data}"/>`; }
    else {
      let x1 = x, y1 = y, x2 = o.x2 ?? x + w, y2 = o.y2 ?? y + h;
      if (o.type === 'connector') { const a = objects.get(o.from), b = objects.get(o.to); if (!a || !b) return ''; x1 = (a.x || 0) + (a.width || 140) / 2; y1 = (a.y || 0) + (a.height || 80) / 2; x2 = (b.x || 0) + (b.width || 140) / 2; y2 = (b.y || 0) + (b.height || 80) / 2; }
      body = `<path d="M${x1} ${y1} L${x2} ${y2}" ${style}/>`;
      if (o.type !== 'line') { const a = Math.atan2(y2 - y1, x2 - x1), size = 12; body += `<path d="M${x2 - size * Math.cos(a - .45)} ${y2 - size * Math.sin(a - .45)} L${x2} ${y2} L${x2 - size * Math.cos(a + .45)} ${y2 - size * Math.sin(a + .45)}" ${style}/>`; }
    }
    const transform = o.rotation ? ` transform="rotate(${o.rotation} ${x + w / 2} ${y + h / 2})"` : '';
    return `<g data-object-id="${o.id}"${transform}><title>${xml(o.type)} · ${xml(o.createdBy.kind)}; changed by ${xml(o.updatedBy.kind)} · r${o.revision}</title>${body}${showOrigins && (o.createdBy.kind === 'agent' || o.updatedBy.kind === 'agent') ? `<text x="${x}" y="${y - 8}" font-family="sans-serif" font-size="11" fill="#555555">agent</text>` : ''}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" role="img" aria-label="${xml(document.title)}"><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="white"/>${items}</svg>`;
}
