import { notebookObjectBounds, notebookHit, pointInPolygon, translateNotebookObject, notebookSceneBounds, notebookConnectorRoute } from '../notebook_geometry.mjs';
import { notebookInkOutline, notebookInkRadius } from '../notebook_ink.mjs';
import { NotebookStroke } from '../notebook_gestures.mjs';
const clone = value => structuredClone(value);

/** Retained canvas: live pen/transform state never belongs to an incoming server snapshot. */
export class NotebookCanvas {
  constructor(canvas, { enqueue, onSelection = () => {}, onText = () => {}, onView = () => {}, onInteraction = () => {}, onRendered = () => {}, onError = () => {}, onSaving = () => {} } = {}) {
    Object.assign(this, { canvas, enqueue, onSelection, onText, onView, onInteraction, onRendered, onError, onSaving });
    this.document = { objects: [], assets: {} }; this.selection = new Set(); this.tool = 'ink'; this.brush = { color: '#000000', width: 3 };
    this.view = { x: 32, y: 32, scale: 1 }; this.fingerInk = false; this.readOnly = false; this.closed = false;
    this.images = new Map(); this.paths = new Map(); this.pointers = new Map(); this.tasks = new Set(); this.frame = 0; this.gesture = null;
    this.finishingStrokes = new Set(); this.failedStrokes = []; this.lastStrokeWrite = Promise.resolve();
    this.controller = new AbortController();
    const listen = (name, callback, options = {}) => canvas.addEventListener(name, callback, { ...options, signal: this.controller.signal });
    listen('pointerdown', event => this.down(event)); listen('pointermove', event => this.move(event));
    listen('pointerup', event => this.up(event)); listen('pointercancel', event => this.up(event));
    listen('lostpointercapture', event => { if (this.pointers.has(event.pointerId)) this.up(event); });
    listen('wheel', event => { event.preventDefault(); if (this.gesture?.kind === 'ink') return; this.onInteraction(); const at = this.screen(event); this.zoomAt(...at, Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * .003)); }, { passive: false });
    listen('keydown', event => {
      this.onInteraction();
      if (this.readOnly || event.ctrlKey || event.metaKey || event.altKey) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && this.selection.size) {
        event.preventDefault(); const step = event.shiftKey ? 10 : 1;
        this.moveSelection(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
      } else if (['Delete', 'Backspace'].includes(event.key) && this.selection.size) { event.preventDefault(); this.deleteSelection(); }
      else if (event.key === 'Escape') { this.select([]); this.onInteraction(); }
    });
    this.observer = new ResizeObserver(() => this.schedule()); this.observer.observe(canvas); this.schedule();
  }
  setDocument(document) {
    this.document = document; this.byId = new Map(document.objects.map(object => [object.id, object])); const ids = new Set(document.objects.map(object => object.id));
    for (const id of this.selection) if (!ids.has(id)) this.selection.delete(id);
    for (const id of this.paths.keys()) if (!ids.has(id)) this.paths.delete(id);
    this.schedule();
  }
  select(ids) { this.selection = new Set(ids); this.onSelection([...this.selection]); this.schedule(); }
  setAgentPen(progress) { this.agentPen = progress && !progress.completed ? progress : null; this.schedule(); }
  setTool(tool) { if (this.gesture) return false; this.tool = tool; this.connectorFrom = null; this.canvas.style.cursor = tool === 'pan' ? 'grab' : tool === 'text' ? 'text' : 'crosshair'; return true; }
  screen(event) { const box = this.canvas.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top]; }
  world(event, view = this.view) { const p = this.screen(event); return [(p[0] - view.x) / view.scale, (p[1] - view.y) / view.scale, event.pointerType === 'pen' ? Math.max(0, Math.min(1, event.pressure)) : .65]; }
  zoomAt(x, y, factor) {
    const scale = Math.max(.05, Math.min(20, this.view.scale * factor)), ratio = scale / this.view.scale;
    this.view = { x: x - (x - this.view.x) * ratio, y: y - (y - this.view.y) * ratio, scale }; this.onView({ ...this.view }); this.schedule();
  }
  fit() {
    const b = notebookSceneBounds(this.document), rect = this.canvas.getBoundingClientRect(), scale = Math.max(.05, Math.min(4, Math.min((rect.width - 48) / b.width, (rect.height - 48) / b.height)));
    this.view = { x: (rect.width - b.width * scale) / 2 - b.x * scale, y: (rect.height - b.height * scale) / 2 - b.y * scale, scale }; this.onView({ ...this.view }); this.schedule();
  }
  viewportBounds() { return [-this.view.x / this.view.scale, -this.view.y / this.view.scale, this.canvas.clientWidth / this.view.scale, this.canvas.clientHeight / this.view.scale]; }
  frameViewport(bounds) {
    if (this.gesture || !Array.isArray(bounds) || bounds.length !== 4 || bounds.some((n, i) => !Number.isFinite(n) || (i < 2 ? Math.abs(n) > 1e7 : n < 1 || n > 1e6))) return false;
    const [x, y, width, height] = bounds, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w < 1 || h < 1) return false;
    const scale = Math.min(20, w / width, h / height);
    this.view = { x: w / 2 - (x + width / 2) * scale, y: h / 2 - (y + height / 2) * scale, scale };
    this.onView({ ...this.view }); this.schedule(); return true;
  }
  async run(work) {
    const promise = Promise.resolve(work); this.tasks.add(promise); this.onSaving(this.tasks.size);
    try { return await promise; } catch (error) { this.onError(error); return null; }
    finally { this.tasks.delete(promise); this.onSaving(this.tasks.size); }
  }
  edit(edits, gestureId = crypto.randomUUID()) {
    if (this.readOnly || !edits.length) return Promise.resolve(null);
    const written = this.lastStrokeWrite.then(() => this.enqueue(edits, { gestureId }));
    this.lastStrokeWrite = written.catch(() => {}); return this.run(written);
  }
  down(event) {
    if (event.button !== 0 && !(event.pointerType === 'pen' && event.button === 5)) return;
    event.preventDefault(); this.canvas.focus({ preventScroll: true });
    if (this.gesture?.kind === 'ink' && event.pointerType === 'touch') return;
    if (event.pointerType === 'pen' && this.gesture?.kind === 'pan') { this.pointers.clear(); this.gesture = null; }
    this.pointers.set(event.pointerId, this.screen(event)); this.canvas.setPointerCapture(event.pointerId); this.onInteraction();
    if (event.pointerType === 'touch' && this.pointers.size > 1 && !this.fingerInk) { this.gesture = { kind: 'pan', pointerId: null, pinch: this.pinch() }; return; }
    if (this.gesture) return;
    const at = this.world(event), screen = this.screen(event);
    if (this.readOnly || this.tool === 'pan' || event.pointerType === 'touch' && !this.fingerInk) { this.gesture = { kind: 'pan', pointerId: event.pointerId, last: screen }; return; }
    const tool = event.pointerType === 'pen' && event.button === 5 ? 'eraser' : this.tool;
    if (tool === 'ink') {
      // Let the next pen-down draw immediately while preserving gesture order in the durable undo history.
      const previousWrite = this.lastStrokeWrite;
      const stroke = new NotebookStroke({ enqueue: async (...args) => { await previousWrite; return this.enqueue(...args); }, color: this.brush.color, width: this.brush.width });
      this.gesture = { kind: 'ink', pointerId: event.pointerId, stroke, points: [at], view: { ...this.view } }; this.run(stroke.append([at]));
    } else if (tool === 'eraser') { this.gesture = { kind: 'eraser', pointerId: event.pointerId, erased: new Set(), id: crypto.randomUUID() }; this.erase(at); }
    else if (tool === 'select') {
      const hit = notebookHit(this.document, at, 6 / this.view.scale);
      if (hit) {
        if (!this.selection.has(hit.id)) this.select(event.shiftKey ? [...this.selection, hit.id] : [hit.id]);
        if (!hit.locked) this.gesture = { kind: 'transform', pointerId: event.pointerId, start: at, before: this.document.objects.filter(object => this.selection.has(object.id) && !object.locked).map(clone), dx: 0, dy: 0 };
      } else { if (!event.shiftKey) this.select([]); this.gesture = { kind: 'lasso', pointerId: event.pointerId, points: [at], initial: event.shiftKey ? [...this.selection] : [] }; }
    } else if (tool === 'text') this.onText({ x: at[0], y: at[1] });
    else if (tool === 'connector') {
      const hit = notebookHit(this.document, at, 6 / this.view.scale); if (!hit || hit.type === 'connector') return;
      if (!this.connectorFrom) { this.connectorFrom = hit.id; this.select([hit.id]); }
      else if (this.connectorFrom !== hit.id) {
        const id = crypto.randomUUID(); this.edit([{ kind: 'put', id, expectedRevision: 0, object: { id, type: 'connector', from: this.connectorFrom, to: hit.id, color: this.brush.color, strokeWidth: this.brush.width } }]); this.connectorFrom = null; this.select([id]);
      }
    } else if (['rect', 'ellipse', 'line', 'arrow'].includes(tool)) this.gesture = { kind: 'shape', tool, pointerId: event.pointerId, start: at, end: at };
    this.schedule();
  }
  pinch() { const p = [...this.pointers.values()].slice(0, 2); return p.length === 2 ? { x: (p[0][0] + p[1][0]) / 2, y: (p[0][1] + p[1][1]) / 2, distance: Math.max(1, Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1])) } : null; }
  move(event) {
    if (!this.pointers.has(event.pointerId)) return;
    event.preventDefault(); this.pointers.set(event.pointerId, this.screen(event)); const g = this.gesture; if (!g) return;
    if (g.kind === 'pan') {
      const pinch = this.pinch();
      if (pinch && g.pinch) { this.zoomAt(g.pinch.x, g.pinch.y, pinch.distance / g.pinch.distance); this.view.x += pinch.x - g.pinch.x; this.view.y += pinch.y - g.pinch.y; }
      else if (!pinch && g.pointerId === event.pointerId && g.last) { const at = this.screen(event); this.view.x += at[0] - g.last[0]; this.view.y += at[1] - g.last[1]; }
      g.pinch = pinch; g.last = this.screen(event); this.onView({ ...this.view }); this.schedule(); return;
    }
    if (g.pointerId !== event.pointerId) return;
    const at = this.world(event, g.view || this.view);
    if (g.kind === 'ink') {
      const events = event.getCoalescedEvents?.() || [], points = (events.length ? events : [event]).map(item => this.world(item, g.view));
      g.points.push(...points); if (g.points.length > 4096) g.points = g.points.slice(-4096); this.run(g.stroke.append(points));
    } else if (g.kind === 'eraser') this.erase(at);
    else if (g.kind === 'transform') { g.dx = at[0] - g.start[0]; g.dy = at[1] - g.start[1]; }
    else if (g.kind === 'lasso') g.points.push(at);
    else if (g.kind === 'shape') g.end = at;
    this.schedule();
  }
  up(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId); if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    const g = this.gesture; if (!g) return;
    if (g.kind === 'pan') { const remaining = [...this.pointers.entries()][0]; if (remaining) { g.pointerId = remaining[0]; g.last = remaining[1]; g.pinch = null; } else this.gesture = null; this.onView({ ...this.view }); return; }
    if (g.pointerId !== event.pointerId) return;
    const finalPoint = (!event.type || event.type === 'pointerup') && Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? this.world(event, g.view) : null;
    if (g.kind === 'ink') {
      if (finalPoint && finalPoint.some((value, index) => value !== g.points.at(-1)[index])) { g.points.push(finalPoint); this.run(g.stroke.append([finalPoint])); }
      this.gesture = null; this.finishingStrokes.add(g);
      const finished = g.stroke.finish(); this.lastStrokeWrite = finished.catch(() => {});
      this.run(finished).then(() => {
        if (g.stroke.error) { this.failedStroke = g.stroke.recovery(); this.failedStrokes.push(this.failedStroke); }
        this.finishingStrokes.delete(g); this.schedule();
      });
    }
    else {
      this.gesture = null;
      if (finalPoint) {
        if (g.kind === 'shape') g.end = finalPoint;
        else if (g.kind === 'transform') { g.dx = finalPoint[0] - g.start[0]; g.dy = finalPoint[1] - g.start[1]; }
        else if (g.kind === 'lasso') g.points.push(finalPoint);
      }
      if (g.kind === 'transform' && Math.abs(g.dx) + Math.abs(g.dy) > .1) this.edit(g.before.map(object => ({ kind: 'patch', id: object.id, expectedRevision: object.revision, patch: translateNotebookObject(object, g.dx, g.dy) })));
      else if (g.kind === 'lasso') this.select([...new Set([...g.initial, ...this.document.objects.filter(object => { const b = notebookObjectBounds(object, this.document.objects); return pointInPolygon([b.x + b.width / 2, b.y + b.height / 2], g.points); }).map(object => object.id)])]);
      else if (g.kind === 'shape') { const object = this.shape(g); this.edit([{ kind: 'put', id: object.id, expectedRevision: 0, object }]); this.select([object.id]); }
      this.schedule();
    }
  }
  shape(g) { const [x, y] = g.start, [x2, y2] = g.end; return { id: g.id ||= crypto.randomUUID(), type: g.tool, x, y, width: x2 - x || 1, height: y2 - y || 1, ...(['line', 'arrow'].includes(g.tool) ? { x2, y2 } : {}), color: this.brush.color, strokeWidth: this.brush.width }; }
  erase(at) { const hit = notebookHit(this.document, at, 9 / this.view.scale); if (!hit || hit.locked || this.gesture.erased.has(hit.id)) return; this.gesture.erased.add(hit.id); this.edit([{ kind: 'delete', id: hit.id, expectedRevision: hit.revision }], this.gesture.id); }
  selected() { return this.document.objects.filter(object => this.selection.has(object.id)); }
  deleteSelection() { return this.edit(this.selected().map(object => ({ kind: 'delete', id: object.id, expectedRevision: object.revision }))); }
  moveSelection(dx, dy) { return this.edit(this.selected().map(object => ({ kind: 'patch', id: object.id, expectedRevision: object.revision, patch: translateNotebookObject(object, dx, dy) }))); }
  patchSelection(patch) { return this.edit(this.selected().map(object => ({ kind: 'patch', id: object.id, expectedRevision: object.revision, patch }))); }
  schedule() { if (!this.frame && !this.closed) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); }); }
  image(assetId) {
    if (this.images.has(assetId)) return this.images.get(assetId);
    const asset = this.document.assets[assetId]; if (!asset) return null;
    const image = new Image(); this.images.set(assetId, image); image.src = `data:${asset.mimeType};base64,${asset.data}`;
    image.decode().then(() => {
      if (image.naturalWidth * image.naturalHeight > 16_000_000) { this.images.set(assetId, null); this.onError(new Error('The image exceeds the 16 million pixel rendering limit. Original bytes are retained.')); }
      let pixels = [...this.images.values()].reduce((sum, value) => sum + (value?.naturalWidth || 0) * (value?.naturalHeight || 0), 0);
      for (const [key, value] of this.images) { if (pixels <= 32_000_000 && this.images.size <= 32) break; if (key === assetId) continue; pixels -= (value?.naturalWidth || 0) * (value?.naturalHeight || 0); this.images.delete(key); }
      this.schedule();
    }).catch(() => { this.images.set(assetId, null); this.onError(new Error('An embedded image could not be decoded. Its original bytes are retained.')); this.schedule(); });
    return image;
  }
  paintObject(ctx, o) {
    const x = o.x || 0, y = o.y || 0, w = o.width ?? 140, h = o.height ?? 80;
    ctx.save(); ctx.strokeStyle = o.color || '#222222'; ctx.fillStyle = !o.fill || o.fill === 'none' ? 'transparent' : o.fill; ctx.lineWidth = o.strokeWidth || 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // Selection uses dashes after the scene. They must not leak into the next
    // paint, otherwise saved shapes change appearance after a refresh or fit.
    ctx.setLineDash([]);
    if (o.rotation) { ctx.translate(x + w / 2, y + h / 2); ctx.rotate(o.rotation * Math.PI / 180); ctx.translate(-x - w / 2, -y - h / 2); }
    if (o.type === 'ink') {
      let cached = o.revision > 0 ? this.paths.get(o.id) : null;
      if (!cached || cached.revision !== o.revision || cached.points !== o.points.length) {
        const outline = notebookInkOutline(o.points, o.strokeWidth || 2), line = new Path2D(); outline.forEach(([px, py], i) => i ? line.lineTo(px, py) : line.moveTo(px, py)); line.closePath();
        for (const p of [o.points[0], o.points.at(-1)]) { const r = notebookInkRadius(p, o.strokeWidth || 2); line.moveTo(p[0] + r, p[1]); line.arc(p[0], p[1], r, 0, Math.PI * 2); }
        cached = { revision: o.revision, points: o.points.length, line }; if (o.revision > 0) this.paths.set(o.id, cached);
      }
      ctx.fillStyle = o.color || '#222222'; ctx.fill(cached.line);
    } else if (o.type === 'text') { ctx.fillStyle = o.color || '#222222'; ctx.font = `${o.fontSize || 18}px sans-serif`; o.text.split('\n').forEach((line, i) => ctx.fillText(line, x, y + i * (o.fontSize || 18) * (o.lineHeight || 1.3))); }
    else if (o.type === 'image') { const image = this.image(o.asset); if (image?.complete && image.naturalWidth && image.naturalWidth * image.naturalHeight <= 16_000_000) ctx.drawImage(image, x, y, Math.abs(w), Math.abs(h)); else { ctx.strokeRect(x, y, Math.abs(w), Math.abs(h)); ctx.fillStyle = '#222222'; ctx.font = '14px sans-serif'; ctx.fillText('Image loading / unavailable', x + 8, y + 24); } }
    else if (o.type === 'rect' || o.type === 'ellipse') { ctx.beginPath(); if (o.type === 'rect') ctx.rect(x, y, w, h); else ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    else {
      let from = [x, y], to = [o.x2 ?? x + w, o.y2 ?? y + h];
      const route = o.type === 'connector' ? notebookConnectorRoute(o, this.byId) : [from, to];
      if (!route.length) { ctx.restore(); return; }
      from = route.at(-2); to = route.at(-1);
      ctx.beginPath(); route.forEach((point, i) => i ? ctx.lineTo(...point) : ctx.moveTo(...point)); ctx.stroke();
      if (o.type !== 'line') { const angle = Math.atan2(to[1] - from[1], to[0] - from[0]), size = Math.max(10, ctx.lineWidth * 3); ctx.beginPath(); ctx.moveTo(to[0] - Math.cos(angle - .45) * size, to[1] - Math.sin(angle - .45) * size); ctx.lineTo(...to); ctx.lineTo(to[0] - Math.cos(angle + .45) * size, to[1] - Math.sin(angle + .45) * size); ctx.stroke(); }
    }
    ctx.restore();
  }
  draw() {
    const rect = this.canvas.getBoundingClientRect(), dpr = Math.min(2, globalThis.devicePixelRatio || 1); if (rect.width < 1 || rect.height < 1) return;
    const width = Math.ceil(rect.width * dpr), height = Math.ceil(rect.height * dpr); if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    const ctx = this.canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, rect.width, rect.height); ctx.translate(this.view.x, this.view.y); ctx.scale(this.view.scale, this.view.scale);
    const g = this.gesture, transforming = g?.kind === 'transform' ? new Set(g.before.map(o => o.id)) : new Set();
    const visible = { x: -this.view.x / this.view.scale, y: -this.view.y / this.view.scale, width: rect.width / this.view.scale, height: rect.height / this.view.scale };
    for (const o of this.document.objects) { const b = notebookObjectBounds(o, this.byId); if (!transforming.has(o.id) && b.x + b.width >= visible.x && b.x <= visible.x + visible.width && b.y + b.height >= visible.y && b.y <= visible.y + visible.height) this.paintObject(ctx, o); }
    if (g?.kind === 'transform') for (const o of g.before) this.paintObject(ctx, { ...o, ...translateNotebookObject(o, g.dx, g.dy), revision: -1 });
    for (const pending of this.finishingStrokes) this.paintObject(ctx, { id: 'pending-preview', type: 'ink', points: pending.points, revision: -1, color: pending.stroke.color, strokeWidth: pending.stroke.width });
    if (g?.kind === 'ink') this.paintObject(ctx, { id: 'live-preview', type: 'ink', points: g.points, revision: -1, color: g.stroke.color, strokeWidth: g.stroke.width });
    if (g?.kind === 'shape') this.paintObject(ctx, this.shape(g));
    ctx.lineWidth = 1 / this.view.scale; ctx.strokeStyle = '#333333'; ctx.setLineDash([6 / this.view.scale, 4 / this.view.scale]);
    for (const o of this.selected()) { const b = notebookObjectBounds(transforming.has(o.id) ? { ...o, ...translateNotebookObject(o, g.dx, g.dy) } : o, this.byId); ctx.strokeRect(b.x - 4 / this.view.scale, b.y - 4 / this.view.scale, b.width + 8 / this.view.scale, b.height + 8 / this.view.scale); }
    if (g?.kind === 'lasso' && g.points.length) { ctx.beginPath(); g.points.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke(); }
    const pen = this.agentPen, reached = pen && this.byId?.get(pen.objectId)?.points?.at(-1);
    if (pen && reached && Date.now() - pen.at < 3000 && reached[0] === pen.point?.[0] && reached[1] === pen.point?.[1]) {
      ctx.save(); ctx.setLineDash([]); ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#000000'; ctx.lineWidth = 2 / this.view.scale;
      ctx.beginPath(); ctx.arc(reached[0], reached[1], 6 / this.view.scale, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#000000'; ctx.font = `${12 / this.view.scale}px system-ui`; ctx.fillText('Codex', reached[0] + 10 / this.view.scale, reached[1] - 10 / this.view.scale); ctx.restore();
    }
    this.onRendered();
  }
  async settle() { if (this.gesture) { const id = this.gesture.pointerId; if (id !== null && id !== undefined) this.up({ pointerId: id }); else { this.gesture = null; this.pointers.clear(); } } await Promise.allSettled([...this.tasks]); }
  dispose() { this.closed = true; this.controller.abort(); this.observer.disconnect(); cancelAnimationFrame(this.frame); this.images.clear(); this.paths.clear(); }
}
