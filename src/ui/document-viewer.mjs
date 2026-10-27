// Shared viewer for images and PDF files: pages, zoom from 1x to 32x of the whole-page fit, a remembered
// "Whole" framing per document, and "Annotate", which opens a notebook with the visible page as a locked background.
// The pure helpers (framing, keys, annotation path) are exported for unit tests; mountDocumentViewer needs a browser.

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 32;
export const MAX_CANVAS_PIXELS = 16_000_000;
export const VIEWPORT_LIMIT = 200;
const MAX_CANVAS_SIDE = 16384;
const VIEWPORT_INDEX_KEY = 'context-room-viewport-index';
const PDFJS_BASE = '/vendor/pdfjs/';
const ANNOTATION_PAGE_SIDE = 2400;
const ANNOTATION_PAGE_SCALE = 2;

export function clampZoom(value) { const zoom = Number(value); return Number.isFinite(zoom) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) : ZOOM_MIN; }

/** Whole-page fit: the smaller of the two ratios, centred across, aligned to the top. */
export function fitFrame(content, view) {
  const scale = Math.min(view.width / content.width, view.height / content.height);
  const width = content.width * scale, height = content.height * scale;
  return { scale, width, height, x: Math.max(0, (view.width - width) / 2), y: 0 };
}

const offsetOf = (size, view) => Math.max(0, (view - size) / 2);

/** A remembered manual framing {zoom, cx, cy} (cx, cy = centre as a fraction of the content) in the current view. */
export function manualFrame(saved, content, view) {
  const fit = fitFrame(content, view), zoom = clampZoom(saved?.zoom), width = fit.width * zoom, height = fit.height * zoom;
  const cx = Math.min(1, Math.max(0, Number.isFinite(saved?.cx) ? saved.cx : 0.5)), cy = Math.min(1, Math.max(0, Number.isFinite(saved?.cy) ? saved.cy : 0));
  const scrollLeft = Math.min(Math.max(0, width - view.width), Math.max(0, cx * width - view.width / 2 + offsetOf(width, view.width)));
  const scrollTop = Math.min(Math.max(0, height - view.height), Math.max(0, cy * height - view.height / 2));
  return { zoom, width, height, scrollLeft, scrollTop };
}

/** The framing to remember from a scroll position; the inverse of manualFrame. */
export function frameFromScroll({ scrollLeft, scrollTop }, size, view, zoom) {
  const x = offsetOf(size.width, view.width), y = offsetOf(size.height, view.height);
  const clamp = value => Math.min(1, Math.max(0, value));
  return { mode: 'manual', zoom: clampZoom(zoom), cx: Math.round(clamp((scrollLeft + view.width / 2 - x) / size.width) * 1e4) / 1e4, cy: Math.round(clamp((scrollTop + view.height / 2 - y) / size.height) * 1e4) / 1e4 };
}

/** Scroll position that keeps the content point under (px, py) in place when the content size changes. */
export function focalScroll({ scrollLeft, scrollTop }, before, after, view, point) {
  const fx = (scrollLeft + point.x - offsetOf(before.width, view.width)) / before.width, fy = (scrollTop + point.y - offsetOf(before.height, view.height)) / before.height;
  return {
    scrollLeft: Math.min(Math.max(0, after.width - view.width), Math.max(0, fx * after.width + offsetOf(after.width, view.width) - point.x)),
    scrollTop: Math.min(Math.max(0, after.height - view.height), Math.max(0, fy * after.height + offsetOf(after.height, view.height) - point.y)),
  };
}

export function viewportKey(projectId, path, hash, page = 1) { return 'context-room-viewport:' + (projectId || '') + ':' + path + ':' + (hash || '') + ':' + (page || 1); }
export function pdfPageKey(projectId, path) { return 'context-room-pdf-page:' + (projectId || '') + ':' + path; }

function readJson(storage, key) { try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; } }

export function readViewport(storage, key) {
  const saved = readJson(storage, key);
  if (saved?.mode === 'fit') return { mode: 'fit', zoom: ZOOM_MIN };
  if (saved?.mode === 'manual' && Number.isFinite(saved.zoom)) return { mode: 'manual', zoom: clampZoom(saved.zoom), cx: saved.cx, cy: saved.cy };
  return null;
}

/** Stores a framing; only the newest `limit` framings are kept, the oldest keys are removed. */
export function rememberViewport(storage, key, frame, limit = VIEWPORT_LIMIT) {
  try {
    storage.setItem(key, JSON.stringify(frame.mode === 'fit' ? { mode: 'fit' } : { mode: 'manual', zoom: frame.zoom, cx: frame.cx, cy: frame.cy }));
    const index = (readJson(storage, VIEWPORT_INDEX_KEY) || []).filter(entry => typeof entry === 'string' && entry !== key);
    index.push(key);
    while (index.length > limit) storage.removeItem(index.shift());
    storage.setItem(VIEWPORT_INDEX_KEY, JSON.stringify(index));
  } catch { /* storage full or unavailable: the framing is simply not remembered */ }
}

/** "Whole page" / "Whole image": forget the manual framing and remember the fit. */
export function wholeViewport(storage, key) { rememberViewport(storage, key, { mode: 'fit' }); return { mode: 'fit', zoom: ZOOM_MIN }; }

export function annotationTitle(path, page) { return 'Annotation · ' + path.split('/').pop() + (page ? ' · page ' + page : ''); }

/** `<folder>/<name> – annotation[ p<N>].crnb`, with ` 2`, ` 3`… when the path is taken. */
export function annotationPath(path, page, taken = new Set()) {
  const slash = path.lastIndexOf('/'), folder = slash < 0 ? '' : path.slice(0, slash + 1), file = path.slice(slash + 1);
  const stem = file.replace(/\.[^.]*$/, '') || file, base = folder + stem + ' – annotation' + (page ? ' p' + page : '');
  let candidate = base + '.crnb';
  for (let n = 2; taken.has(candidate); n++) candidate = base + ' ' + n + '.crnb';
  return candidate;
}

/** Backing-store size of a page canvas: device pixels, capped at 16 million pixels and 16384 per side. */
export function canvasBudget(width, height, ratio = 1) {
  const w = Math.max(1, width * ratio), h = Math.max(1, height * ratio);
  const scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (w * h)), MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h);
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

function el(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
function button(label, onClick, { aria = '', className = '' } = {}) { const node = el('button', 'dv-button ' + className, label); node.type = 'button'; if (aria) node.setAttribute('aria-label', aria); node.addEventListener('click', onClick); return node; }
function formatBytes(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' B'; }
function decodeDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(','), binary = atob(dataUrl.slice(comma + 1)), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const toBlob = (canvas, type = 'image/png') => new Promise(resolve => canvas.toBlob(resolve, type));

let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ||= import(PDFJS_BASE + 'pdf.min.mjs').then(module => { module.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.mjs'; return module; }).catch(error => { pdfjsPromise = null; throw error; });
  return pdfjsPromise;
}
// The last opened PDF stays parsed, so the viewer can be rebuilt (the app redraws its panel) without parsing it again.
let lastPdf = null;
async function openPdf(asset) {
  const key = asset.contentHash || asset.path;
  if (lastPdf?.key === key) return lastPdf.promise;
  // The previous document owns a worker thread and its bytes: release them before a new one is opened.
  lastPdf?.task?.destroy().catch(() => {});
  const entry = { key, task: null, promise: null };
  entry.promise = (async () => {
    const pdfjs = await loadPdfjs();
    entry.task = pdfjs.getDocument({ data: decodeDataUrl(asset.dataUrl), isEvalSupported: false, enableXfa: false, standardFontDataUrl: PDFJS_BASE + 'standard_fonts/', cMapUrl: PDFJS_BASE + 'cmaps/', cMapPacked: true, wasmUrl: PDFJS_BASE + 'wasm/', maxImageSize: MAX_CANVAS_PIXELS, canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4 });
    // Another PDF may have been asked for while pdf.js loaded: nobody will destroy this task later, so do it now.
    if (lastPdf !== entry) entry.task.destroy().catch(() => {});
    return entry.task.promise;
  })();
  lastPdf = entry;
  entry.promise.catch(() => { if (lastPdf === entry) lastPdf = null; entry.task?.destroy().catch(() => {}); });
  return entry.promise;
}

/**
 * Mounts the viewer into `host`. `asset` is the file read result (dataUrl, mimeType, bytes, contentHash).
 * `annotate({ path, title, file })` opens the notebook; `existingPaths()` lists project paths already in use.
 */
export function mountDocumentViewer(host, { asset, path, projectId = '', storage = globalThis.localStorage, annotate, existingPaths = () => new Set(), retry } = {}) {
  const isPdf = asset.mimeType === 'application/pdf', noun = isPdf ? 'page' : 'image';
  host.textContent = '';
  const root = el('div', 'dv-root'); root.tabIndex = 0; root.setAttribute('role', 'group'); root.setAttribute('aria-label', (isPdf ? 'PDF viewer: ' : 'Image viewer: ') + path);
  const toolbar = el('div', 'dv-toolbar'), info = el('span', 'dv-info', (isPdf ? 'PDF' : (asset.mimeType || 'image').replace('image/', '').replace('+xml', '').replace('jpeg', 'jpg').toUpperCase()) + ' · ' + formatBytes(asset.bytes || 0));
  const stage = el('div', 'dv-stage'), content = el('div', 'dv-content'); stage.append(content);
  const form = el('form', 'dv-annotate'); form.hidden = true;
  const state = { zoom: ZOOM_MIN, mode: 'fit', page: 1, pages: 1, natural: null, destroyed: false, renderToken: 0, persistTimer: 0, renderTimer: 0, pdf: null, pdfPage: null, renderTask: null, view: null, pointers: new Map(), pinch: null };
  let target = null; // <img> or <canvas>
  const wholeButton = button('Whole ' + noun, () => whole()), out = button('−', () => zoomBy(1 / 1.5), { aria: 'Zoom out' }), level = el('span', 'dv-level', '100 %'), zin = button('+', () => zoomBy(1.5), { aria: 'Zoom in' });
  level.setAttribute('aria-live', 'polite');
  const annotateButton = button('Annotate', () => openAnnotate(), { className: 'dv-primary' }), canAnnotate = typeof annotate === 'function'; annotateButton.disabled = true;
  if (!canAnnotate) annotateButton.title = 'Annotating is not available here.';
  toolbar.append(info, wholeButton, out, level, zin, annotateButton);
  root.append(toolbar, form, stage);
  let pageBar = null, pageInput = null, pageTotal = null, pagePrev = null, pageNext = null, pageMessage = null;
  if (isPdf) {
    pageBar = el('div', 'dv-pages'); pageMessage = el('span', 'dv-page-message'); pageMessage.setAttribute('role', 'alert');
    pagePrev = button('‹', () => goTo(state.page - 1), { aria: 'Previous page' }); pageNext = button('›', () => goTo(state.page + 1), { aria: 'Next page' });
    pageInput = el('input', 'dv-page-input'); pageInput.type = 'text'; pageInput.inputMode = 'numeric'; pageInput.setAttribute('aria-label', 'Page number'); pageTotal = el('span', 'dv-page-total', '/ 1');
    const label = el('label', 'dv-page-label', 'Page '); label.append(pageInput, ' ', pageTotal);
    pageInput.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitPageInput(); } });
    pageInput.addEventListener('change', commitPageInput);
    pageBar.append(pagePrev, label, pageNext, pageMessage); root.append(pageBar);
  }
  host.append(root);
  const key = () => viewportKey(projectId, path, asset.contentHash, state.page);
  const viewSize = () => ({ width: stage.clientWidth, height: stage.clientHeight });
  const contentSize = () => { const view = viewSize(), fit = fitFrame(state.natural, view); return { width: Math.max(1, fit.width * state.zoom), height: Math.max(1, fit.height * state.zoom) }; };

  function showError(message, canRetry = true) {
    state.renderToken++; root.classList.add('dv-failed'); stage.textContent = '';
    const box = el('div', 'dv-error'); box.setAttribute('role', 'alert'); box.append(el('strong', '', message.title), el('span', '', message.detail));
    if (canRetry && retry) box.append(button('Retry', () => retry(), { className: 'dv-primary' }));
    stage.append(box); annotateButton.disabled = true; if (pageBar) pageBar.hidden = true; [wholeButton, out, zin].forEach(node => { node.disabled = true; });
  }

  function layout() {
    if (state.destroyed || !state.natural) return;
    const view = viewSize(); if (!view.width || !view.height) return;
    const size = contentSize(); content.style.width = size.width + 'px'; content.style.height = size.height + 'px';
    level.textContent = Math.round(state.zoom * 100) + ' %';
    out.disabled = state.zoom <= ZOOM_MIN; zin.disabled = state.zoom >= ZOOM_MAX;
    return { view, size };
  }

  function applyFrame() {
    state.view = viewSize();
    if (state.mode === 'manual' && state.saved) {
      const frame = manualFrame(state.saved, state.natural, state.view); state.zoom = frame.zoom; layout();
      stage.scrollLeft = frame.scrollLeft; stage.scrollTop = frame.scrollTop;
    } else { state.zoom = ZOOM_MIN; layout(); stage.scrollLeft = 0; stage.scrollTop = 0; }
  }

  function persist() {
    clearTimeout(state.persistTimer);
    state.persistTimer = setTimeout(() => {
      if (state.destroyed || !state.natural) return;
      if (state.mode === 'fit') { rememberViewport(storage, key(), { mode: 'fit' }); return; }
      const view = viewSize(), size = contentSize(); state.saved = frameFromScroll(stage, size, view, state.zoom); rememberViewport(storage, key(), state.saved);
    }, 120);
  }

  async function renderPdfPage() {
    if (!state.pdfPage) return;
    state.renderTask?.cancel();
    const token = ++state.renderToken, size = contentSize();
    const base = state.pdfPage.getViewport({ scale: 1 }), budget = canvasBudget(size.width, size.height, globalThis.devicePixelRatio || 1);
    const canvas = document.createElement('canvas'); canvas.width = budget.width; canvas.height = budget.height; canvas.className = 'dv-canvas'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Page ' + state.page + ' of ' + state.pages);
    const viewport = state.pdfPage.getViewport({ scale: budget.width / base.width });
    const task = state.renderTask = state.pdfPage.render({ canvas, viewport, background: '#ffffff', annotationMode: 0 });
    try { await task.promise; } catch (error) { canvas.width = 0; if (error?.name === 'RenderingCancelledException' || token !== state.renderToken) return; throw error; }
    if (state.renderTask === task) state.renderTask = null;
    if (state.destroyed || token !== state.renderToken) { canvas.width = 0; return; }
    const previous = target;
    if (previous?.isConnected) previous.replaceWith(canvas); else content.append(canvas);
    if (previous instanceof HTMLCanvasElement) previous.width = 0; // free the old backing store at once
    target = canvas;
  }
  function scheduleRender() { if (!isPdf) return; clearTimeout(state.renderTimer); state.renderTimer = setTimeout(() => renderPdfPage().catch(showRenderError), 250); }
  function showRenderError(error) { showError({ title: 'This page could not be displayed.', detail: String(error?.message || error).slice(0, 160) }); }

  function setZoom(next, point) {
    const zoom = clampZoom(next); if (zoom === state.zoom || !state.natural) return;
    const view = viewSize(), before = contentSize(), start = { scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop };
    state.zoom = zoom; state.mode = 'manual';
    const after = contentSize(); layout();
    const position = focalScroll(start, before, after, view, point || { x: view.width / 2, y: view.height / 2 });
    stage.scrollLeft = position.scrollLeft; stage.scrollTop = position.scrollTop;
    state.saved = frameFromScroll(stage, after, view, zoom);
    scheduleRender(); persist();
  }
  function zoomBy(factor, point) { setZoom(Math.round(state.zoom * factor * 1000) / 1000, point); }
  function whole() {
    wholeViewport(storage, key()); state.mode = 'fit'; state.saved = null; applyFrame(); scheduleRender();
  }

  async function showPage(number, { restore = true } = {}) {
    state.page = number;
    if (pageInput) { pageInput.value = String(number); pageTotal.textContent = '/ ' + state.pages; pagePrev.disabled = number <= 1; pageNext.disabled = number >= state.pages; pageMessage.textContent = ''; }
    try { storage.setItem(pdfPageKey(projectId, path), String(number)); } catch { /* not remembered */ }
    const saved = restore ? readViewport(storage, key()) : null;
    state.mode = saved?.mode === 'manual' ? 'manual' : 'fit'; state.saved = saved?.mode === 'manual' ? saved : null;
    state.renderTask?.cancel(); const previousPage = state.pdfPage;
    state.pdfPage = await state.pdf.getPage(number); if (state.destroyed || state.page !== number) return;
    if (previousPage && previousPage !== state.pdfPage) previousPage.cleanup();
    const natural = state.pdfPage.getViewport({ scale: 1 }); state.natural = { width: natural.width, height: natural.height };
    applyFrame(); await renderPdfPage();
    if (state.destroyed || state.page !== number) return;
    annotateButton.disabled = !canAnnotate; applyFrame();
  }
  function goTo(number) { if (!isPdf || number < 1 || number > state.pages || number === state.page) return; showPage(number).catch(showRenderError); }
  function commitPageInput() {
    const text = pageInput.value.trim(), number = /^\d+$/.test(text) ? Number(text) : 0;
    if (number < 1 || number > state.pages) { pageMessage.textContent = 'Enter 1–' + state.pages; pageInput.value = String(state.page); return; }
    pageMessage.textContent = ''; goTo(number);
  }

  // Annotate: the visible page (PDF) or the image becomes the locked background of a new notebook.
  async function annotationFile() {
    if (isPdf) {
      const base = state.pdfPage.getViewport({ scale: 1 }), scale = Math.min(ANNOTATION_PAGE_SCALE, ANNOTATION_PAGE_SIDE / Math.max(base.width, base.height));
      const viewport = state.pdfPage.getViewport({ scale }), canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(viewport.width)); canvas.height = Math.max(1, Math.round(viewport.height));
      await state.pdfPage.render({ canvas, viewport, background: '#ffffff', annotationMode: 0 }).promise;
      const blob = await toBlob(canvas); if (!blob) throw new Error('The page could not be turned into an image.');
      return new File([blob], 'page-' + state.page + '.png', { type: 'image/png' });
    }
    const type = asset.mimeType, { width, height } = state.natural;
    if (['image/png', 'image/jpeg', 'image/webp'].includes(type) && (asset.bytes || 0) <= 12 * 1024 * 1024 && width * height <= MAX_CANVAS_PIXELS) return new File([decodeDataUrl(asset.dataUrl)], path.split('/').pop(), { type });
    const size = canvasBudget(width, height, 1), canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, size.width, size.height); context.drawImage(target, 0, 0, size.width, size.height);
    const blob = await toBlob(canvas); if (!blob) throw new Error('The image could not be converted.');
    return new File([blob], path.split('/').pop().replace(/\.[^.]*$/, '') + '.png', { type: 'image/png' });
  }
  function openAnnotate() {
    if (!annotate || annotateButton.disabled) return;
    form.hidden = false; form.textContent = '';
    const label = el('label', 'dv-annotate-label', 'Notebook path'), input = el('input', 'dv-annotate-input'); input.type = 'text'; input.required = true; input.spellcheck = false;
    input.value = annotationPath(path, isPdf ? state.page : 0, existingPaths()); label.append(input);
    const status = el('span', 'dv-annotate-status'); status.setAttribute('role', 'alert');
    const submit = button('Create notebook', () => {}, { className: 'dv-primary' }); submit.type = 'submit';
    const cancel = button('Cancel', () => { form.hidden = true; form.textContent = ''; root.focus(); });
    form.append(label, submit, cancel, status);
    form.onsubmit = async event => {
      event.preventDefault();
      const wanted = input.value.trim().replace(/^\/+/, '');
      if (!/\.crnb$/i.test(wanted)) { status.textContent = 'The path must end with .crnb.'; return; }
      if (existingPaths().has(wanted)) { status.textContent = 'A file already uses this path. Choose another.'; return; }
      submit.disabled = true; status.textContent = 'Preparing the ' + noun + '…';
      try {
        const file = await annotationFile();
        await annotate({ path: wanted, title: annotationTitle(path, isPdf ? state.page : 0), file });
        form.hidden = true; form.textContent = '';
      } catch (error) { status.textContent = String(error?.message || error); submit.disabled = false; }
    };
    input.focus(); input.select();
  }

  // Gestures: wheel with Ctrl and two-finger pinch zoom around the focal point; one finger scrolls natively.
  const stagePoint = event => { const box = stage.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
  stage.addEventListener('wheel', event => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); zoomBy(Math.exp(-event.deltaY * 0.01), stagePoint(event)); }, { passive: false });
  const pinchSpan = () => { const [a, b] = [...state.pointers.values()]; return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; };
  stage.addEventListener('pointerdown', event => {
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size === 2) { const span = pinchSpan(); state.pinch = { distance: span.distance, zoom: state.zoom }; }
  });
  stage.addEventListener('pointermove', event => {
    if (!state.pointers.has(event.pointerId)) return;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size === 2 && state.pinch) {
      const span = pinchSpan(), box = stage.getBoundingClientRect();
      setZoom(Math.round(state.pinch.zoom * span.distance / state.pinch.distance * 1000) / 1000, { x: span.point.x - box.left, y: span.point.y - box.top });
    }
  });
  const endPointer = event => { state.pointers.delete(event.pointerId); if (state.pointers.size < 2) state.pinch = null; };
  stage.addEventListener('pointerup', endPointer); stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('scroll', () => { if (state.mode === 'manual') persist(); }, { passive: true });
  root.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement || event.altKey || event.ctrlKey || event.metaKey) return;
    const fitted = state.zoom <= ZOOM_MIN;
    if (isPdf && (event.key === 'PageDown' || event.key === 'ArrowRight' && fitted)) { event.preventDefault(); goTo(state.page + 1); }
    else if (isPdf && (event.key === 'PageUp' || event.key === 'ArrowLeft' && fitted)) { event.preventDefault(); goTo(state.page - 1); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.5); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(1 / 1.5); }
    else if (event.key === '0') { event.preventDefault(); whole(); }
  });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (!state.natural) return; const before = state.view;
    const view = viewSize(); if (before && before.width === view.width && before.height === view.height) return;
    if (state.mode === 'manual' && before) { const fit = fitFrame(state.natural, before); state.saved = frameFromScroll(stage, { width: fit.width * state.zoom, height: fit.height * state.zoom }, before, state.zoom); }
    applyFrame(); scheduleRender();
  }) : null;
  observer?.observe(stage);

  async function start() {
    stage.setAttribute('aria-busy', 'true');
    try {
      if (isPdf) {
        let pdf;
        try { pdf = await openPdf(asset); } catch (error) {
          if (error?.name === 'InvalidPDFException' || error?.name === 'FormatError' || error?.name === 'MissingPDFException') throw error;
          if (error?.name === 'PasswordException') return showError({ title: 'This PDF is protected by a password.', detail: 'Context Room cannot open it.' }, false);
          return showError({ title: 'This browser cannot display this PDF.', detail: 'Update Android System WebView, or open the file in a recent browser.' });
        }
        if (state.destroyed) return;
        state.pdf = pdf; state.pages = pdf.numPages;
        let page = Number(storage.getItem(pdfPageKey(projectId, path))); if (!Number.isInteger(page) || page < 1 || page > state.pages) page = 1;
        await showPage(page);
      } else {
        const image = new Image(); image.className = 'dv-image'; image.alt = 'Preview of ' + path; image.draggable = false; image.referrerPolicy = 'no-referrer'; image.src = asset.dataUrl;
        await image.decode().catch(() => { throw Object.assign(new Error('The image could not be decoded.'), { name: 'ImageError' }); });
        if (state.destroyed) return;
        state.natural = { width: image.naturalWidth || 800, height: image.naturalHeight || 600 }; target = image; content.append(image);
        info.textContent += ' · ' + state.natural.width + ' × ' + state.natural.height;
        const saved = readViewport(storage, key()); state.mode = saved?.mode === 'manual' ? 'manual' : 'fit'; state.saved = saved?.mode === 'manual' ? saved : null;
        applyFrame(); annotateButton.disabled = !canAnnotate;
      }
    } catch (error) {
      showError({ title: isPdf ? 'This PDF could not be displayed.' : 'Image preview unavailable', detail: isPdf ? 'The file may be damaged or not a PDF.' : 'The visual asset could not be decoded safely.' });
    } finally { stage.removeAttribute('aria-busy'); }
  }
  const started = start();
  return {
    ready: started,
    focus: () => root.focus(),
    destroy() {
      state.destroyed = true; state.renderToken++; clearTimeout(state.persistTimer); clearTimeout(state.renderTimer); observer?.disconnect();
      state.renderTask?.cancel(); state.renderTask = null;
      try { state.pdfPage?.cleanup(); } catch { /* the document may already be released */ }
      if (target instanceof HTMLCanvasElement) target.width = 0;
    },
  };
}
