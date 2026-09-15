/** Portable pressure geometry shared by the retained canvas and inert SVG export. */
export const notebookInkRadius = (point, width = 2, curve = 'soft') => Math.max(.05, width) * (curve === 'linear'
  ? Math.max(.15, Math.min(1, point[2] ?? 1)) : .2 + .8 * Math.max(0, Math.min(1, point[2] ?? .5))) / 2;
export function notebookInkOutline(points, width = 2, curve = 'soft') {
  if (!Array.isArray(points) || !points.length) return [];
  const left = [], right = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i], a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    const nx = length ? -dy / length : 0, ny = length ? dx / length : 1, radius = notebookInkRadius(p, width, curve);
    left.push([p[0] + nx * radius, p[1] + ny * radius]); right.push([p[0] - nx * radius, p[1] - ny * radius]);
  }
  return [...left, ...right.reverse()];
}
