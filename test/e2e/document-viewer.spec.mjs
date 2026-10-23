import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect } from '@playwright/test';
import { initializeContextRoomProject, writeMemoryWebappSettings, createMemoryServer } from '../../src/context_room.mjs';
import { listNotebooks, readNotebook } from '../../src/notebooks.mjs';

// A three-page PDF built in the test: page N shows "Synthetic page N" in large Helvetica.
function makePdf(pages = 3) {
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 48 Tf 60 700 Td (Synthetic page ${i + 1}) Tj ET 0 0 0 rg 60 ${300 + i * 60} 200 80 re f`;
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  }
  let out = '%PDF-1.4\n'; const offsets = [];
  for (let i = 1; i < objects.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// A 32 x 32 JPEG 2000 image (left half red, right half blue, synthetic, made with opj_compress) inside a one-page PDF.
const JPX_BASE64 = 'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAIAAAACAAAwcHAAAAAAAPY29scgEAAAAAABAAAAEOanAyY/9P/1EALwAAAAAAIAAAACAAAAAAAAAAAAAAACAAAAAgAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAQUEBAAB/1wAE0BASEhQSEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAAhwAB/5PPtAgHX8fUBAG/34AQAcOAz8AIAXfPwAgIJ4DH2goACBWtDW/H2goAAV2ZDKOAz8AgFyxzgmCwStvPwCQX2HWCVezl/3+Az8BAIW4NGL56SErnAQ9wudocP8/AKCIaDxi+ZC1mAT+Ax9oKADXyP6q9z8AYNp5B442f/9k=';
function makeJpxPdf() {
  const image = Buffer.from(JPX_BASE64, 'base64').toString('latin1'), content = 'q 400 0 0 400 100 200 cm /Im0 Do Q';
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length ${image.length} >>\nstream\n${image}\nendstream`];
  let out = '%PDF-1.5\n'; const offsets = [];
  for (let i = 1; i < objects.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function makePng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(data.length); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 3 + 1) + 1 + x * 3; rows[at] = (r + x) & 255; rows[at + 1] = (g + y) & 255; rows[at + 2] = b; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(page) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-viewer-')));
  const root = path.join(base, 'project'), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME', 'GIT_CONFIG_GLOBAL']) { previous[key] = process.env[key]; process.env[key] = key === 'GIT_CONFIG_GLOBAL' ? '/dev/null' : path.join(base, key.toLowerCase()); }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/guide.md'), '# Synthetic guide\n');
  fs.writeFileSync(path.join(root, 'docs/brief.pdf'), makePdf(3));
  fs.writeFileSync(path.join(root, 'docs/second.pdf'), makePdf(2));
  fs.writeFileSync(path.join(root, 'docs/jpx.pdf'), makeJpxPdf());
  fs.writeFileSync(path.join(root, 'docs/broken.pdf'), 'this is not a pdf');
  fs.writeFileSync(path.join(root, 'docs/photo.png'), makePng(400, 200, [10, 20, 30]));
  fs.writeFileSync(path.join(root, 'docs/other.png'), makePng(300, 300, [90, 60, 30]));
  initializeContextRoomProject(root, { title: 'Synthetic viewer', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  const runtime = createMemoryServer({ root }); await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${runtime.server.address().port}`, errors = []; page.on('pageerror', error => errors.push(error.message));
  const ready = async () => { await page.goto(origin + '/'); await page.waitForFunction(() => typeof selectFile === 'function' && Boolean(state.ownerMutationNonce && state.projectId && state.files?.length)); };
  await ready();
  return { root, runtime, origin, errors, ready, async close() {
    try { if (!page.isClosed()) await page.goto('about:blank'); }
    finally { await new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections(); }); await runtime.waitForShutdown(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(base, { recursive: true, force: true }); }
  } };
}
async function openFile(page, file) {
  await page.evaluate(name => selectFile(name), file);
  await expect(page.locator('.dv-root')).toBeVisible();
}
async function pdfReady(page, label) {
  const canvas = page.locator('canvas.dv-canvas');
  await expect(canvas).toBeVisible(); if (label) await expect(canvas).toHaveAttribute('aria-label', label);
  await expect.poll(() => canvas.evaluate(node => { const data = node.getContext('2d').getImageData(0, 0, node.width, node.height).data; for (let i = 0; i < data.length; i += 4) if (data[i] < 80 && data[i + 3] > 0) return true; return false; })).toBe(true);
}
const level = page => page.locator('.dv-level');
const storedFrame = page => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('context-room-viewport:') && key !== 'context-room-viewport-index').map(([key, value]) => [key, JSON.parse(value)]));
async function pinch(page, from, to) {
  await page.locator('.dv-stage').evaluate((stage, { from, to }) => {
    const fire = (type, id, x) => stage.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x[0], clientY: x[1], bubbles: true, isPrimary: id === 1 }));
    const box = stage.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + 40;
    fire('pointerdown', 1, [cx - from, cy]); fire('pointerdown', 2, [cx + from, cy]);
    for (let step = 1; step <= 6; step++) { const d = from + (to - from) * step / 6; fire('pointermove', 1, [cx - d, cy]); fire('pointermove', 2, [cx + d, cy]); }
    fire('pointerup', 1, [cx - to, cy]); fire('pointerup', 2, [cx + to, cy]);
  }, { from, to });
}

test('@smoke PDF opens on page 1, pages forward and back, jumps to page 3', async ({ page }) => {
  const f = await fixture(page);
  try {
    await openFile(page, 'docs/brief.pdf');
    await pdfReady(page, 'Page 1 of 3');
    const input = page.getByRole('textbox', { name: 'Page number' });
    await expect(input).toHaveValue('1'); await expect(page.locator('.dv-page-total')).toHaveText('/ 3');
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await page.getByRole('button', { name: 'Next page' }).click(); await pdfReady(page, 'Page 2 of 3'); await expect(input).toHaveValue('2');
    await page.getByRole('button', { name: 'Previous page' }).click(); await pdfReady(page, 'Page 1 of 3'); await expect(input).toHaveValue('1');
    await input.fill('3'); await input.press('Enter'); await pdfReady(page, 'Page 3 of 3'); await expect(input).toHaveValue('3');
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await input.fill('9'); await input.press('Enter');
    await expect(page.locator('.dv-page-message')).toHaveText('Enter 1–3'); await expect(input).toHaveValue('3');
    await page.locator('.dv-root').focus(); await page.keyboard.press('PageUp'); await pdfReady(page, 'Page 2 of 3');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('PDF page and manual zoom are restored after reload; Whole page resets and is remembered', async ({ page }) => {
  const f = await fixture(page);
  try {
    await openFile(page, 'docs/brief.pdf'); await pdfReady(page, 'Page 1 of 3');
    await page.getByRole('button', { name: 'Next page' }).click(); await pdfReady(page, 'Page 2 of 3');
    await page.getByRole('button', { name: 'Zoom in' }).click(); await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(level(page)).toHaveText('225 %');
    await page.locator('.dv-stage').evaluate(stage => { stage.scrollTop = 220; stage.scrollLeft = 90; });
    await expect.poll(async () => (await storedFrame(page)).some(([key, value]) => key.endsWith(':2') && value.mode === 'manual' && value.zoom === 2.25 && value.cy > 0)).toBe(true);
    const scrolled = await page.locator('.dv-stage').evaluate(stage => ({ top: stage.scrollTop, left: stage.scrollLeft }));
    await f.ready(); await openFile(page, 'docs/brief.pdf'); await pdfReady(page, 'Page 2 of 3');
    await expect(page.getByRole('textbox', { name: 'Page number' })).toHaveValue('2'); await expect(level(page)).toHaveText('225 %');
    await expect.poll(() => page.locator('.dv-stage').evaluate(stage => stage.scrollTop)).toBeGreaterThan(scrolled.top - 6);
    expect(Math.abs(await page.locator('.dv-stage').evaluate(stage => stage.scrollTop) - scrolled.top)).toBeLessThan(6);
    await page.getByRole('button', { name: 'Whole page' }).click(); await expect(level(page)).toHaveText('100 %');
    await expect.poll(async () => (await storedFrame(page)).some(([key, value]) => key.endsWith(':2') && value.mode === 'fit')).toBe(true);
    await f.ready(); await openFile(page, 'docs/brief.pdf'); await pdfReady(page, 'Page 2 of 3');
    await expect(level(page)).toHaveText('100 %'); await expect(page.locator('.dv-stage')).toHaveJSProperty('scrollTop', 0);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('image pinch zoom keeps the focal point; Whole image is remembered per document', async ({ page }) => {
  const f = await fixture(page);
  try {
    await openFile(page, 'docs/photo.png'); await expect(page.locator('img.dv-image')).toBeVisible(); await expect(level(page)).toHaveText('100 %');
    const spot = () => page.locator('.dv-content').evaluate(content => { const stage = content.parentElement.getBoundingClientRect(), box = content.getBoundingClientRect(), x = stage.left + stage.width / 2; return (x - box.left) / box.width; });
    const before = await spot();
    await pinch(page, 40, 120);
    await expect.poll(async () => Number((await level(page).textContent()).replace(/\D/g, ''))).toBeGreaterThan(250);
    expect(Math.abs(await spot() - before)).toBeLessThan(0.03);
    await expect.poll(async () => (await storedFrame(page)).some(([, value]) => value.mode === 'manual' && value.zoom > 2.5)).toBe(true);
    await openFile(page, 'docs/other.png'); await expect(level(page)).toHaveText('100 %');
    await openFile(page, 'docs/photo.png'); await expect(page.locator('img.dv-image')).toBeVisible(); await expect(level(page)).not.toHaveText('100 %');
    await page.getByRole('button', { name: 'Whole image' }).click(); await expect(level(page)).toHaveText('100 %');
    await expect.poll(async () => (await storedFrame(page)).filter(([key]) => key.includes('photo.png')).every(([, value]) => value.mode === 'fit')).toBe(true);
    await f.ready(); await openFile(page, 'docs/photo.png'); await expect(level(page)).toHaveText('100 %');
    await page.locator('.dv-root').focus(); await page.keyboard.press('+'); await expect(level(page)).toHaveText('150 %'); await page.keyboard.press('0'); await expect(level(page)).toHaveText('100 %');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('@notebook Annotate a PDF page creates a .crnb with one locked background image', async ({ page }) => {
  const f = await fixture(page);
  try {
    await openFile(page, 'docs/brief.pdf'); await pdfReady(page, 'Page 1 of 3');
    await page.getByRole('button', { name: 'Next page' }).click(); await pdfReady(page, 'Page 2 of 3');
    await page.getByRole('button', { name: 'Annotate' }).click();
    const pathInput = page.getByLabel('Notebook path'); await expect(pathInput).toHaveValue('docs/brief – annotation p2.crnb');
    await page.getByRole('button', { name: 'Create notebook' }).click();
    const dialog = page.locator('dialog.notebook-dialog[open]'); await expect(dialog).toBeVisible(); await expect(dialog).toHaveAttribute('data-save-state', 'confirmed');
    await expect.poll(() => listNotebooks(f.root).find(item => item.path === 'docs/brief – annotation p2.crnb')?.title).toBe('Annotation · brief.pdf · page 2');
    const entry = listNotebooks(f.root).find(item => item.path === 'docs/brief – annotation p2.crnb');
    await expect.poll(() => readNotebook(f.root, entry.id).document.objects.length).toBe(1);
    const [image] = readNotebook(f.root, entry.id).document.objects;
    expect(image).toMatchObject({ type: 'image', x: 0, y: 0, width: 1224, height: 1584, locked: true });
    await expect.poll(() => dialog.locator('canvas.notebook-canvas').evaluate(canvas => { const context = canvas.getContext('2d'); if (!context) return -1; const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let white = 0; for (let i = 0; i < data.length; i += 4) if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) white++; return white / (data.length / 4); })).toBeGreaterThan(0.2);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('@layout viewer toolbar fits at 639 px with 48 px targets', async ({ page }) => {
  await page.setViewportSize({ width: 639, height: 900 });
  const f = await fixture(page);
  try {
    await openFile(page, 'docs/brief.pdf'); await pdfReady(page);
    const measure = () => page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, boxes: [...document.querySelectorAll('.dv-button, .dv-page-input')].map(node => { const box = node.getBoundingClientRect(); return { name: node.textContent || node.getAttribute('aria-label'), width: box.width, height: box.height, right: box.right, left: box.left }; }) }));
    const result = await measure();
    expect(result.overflow).toBeLessThanOrEqual(0); expect(result.boxes.length).toBeGreaterThanOrEqual(7);
    for (const box of result.boxes) { expect(box.height, box.name).toBeGreaterThanOrEqual(48); expect(box.left, box.name).toBeGreaterThanOrEqual(0); expect(box.right, box.name).toBeLessThanOrEqual(639); if (!/page number/i.test(box.name)) expect(box.width, box.name).toBeGreaterThanOrEqual(48); }
    await page.getByRole('button', { name: 'Annotate' }).click();
    await expect(page.getByLabel('Notebook path')).toBeVisible();
    expect((await measure()).overflow).toBeLessThanOrEqual(0);
  } finally { await f.close(); }
});

test('broken PDF shows a readable error and Retry, no page error', async ({ page }) => {
  const f = await fixture(page);
  try {
    await openFile(page, 'docs/broken.pdf');
    const error = page.locator('.dv-error'); await expect(error).toBeVisible(); await expect(error).toContainText('This PDF could not be displayed.');
    await expect(page.getByRole('button', { name: 'Annotate' })).toBeDisabled();
    await error.getByRole('button', { name: 'Retry' }).click(); await expect(page.locator('.dv-error')).toBeVisible();
    await openFile(page, 'docs/brief.pdf'); await pdfReady(page, 'Page 1 of 3');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('opening several PDFs keeps one pdf.js worker alive, not one per document', async ({ page }) => {
  const f = await fixture(page);
  try {
    await openFile(page, 'docs/brief.pdf'); await pdfReady(page, 'Page 1 of 3');
    expect(page.workers().length).toBe(1);
    await page.evaluate(() => selectFile('docs/second.pdf')); await expect(page.locator('canvas.dv-canvas')).toHaveAttribute('aria-label', 'Page 1 of 2'); await pdfReady(page);
    await page.evaluate(() => selectFile('docs/brief.pdf')); await expect(page.locator('canvas.dv-canvas')).toHaveAttribute('aria-label', 'Page 1 of 3'); await pdfReady(page);
    await expect.poll(() => page.workers().length).toBe(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('a PDF with a JPEG 2000 image shows the image through the wasm decoder', async ({ page }) => {
  const f = await fixture(page);
  try {
    await openFile(page, 'docs/jpx.pdf');
    const canvas = page.locator('canvas.dv-canvas'); await expect(canvas).toBeVisible();
    await expect.poll(() => canvas.evaluate(node => { const data = node.getContext('2d').getImageData(0, 0, node.width, node.height).data; let red = 0, blue = 0; for (let i = 0; i < data.length; i += 4) { if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) red++; if (data[i + 2] > 200 && data[i] < 60 && data[i + 1] < 60) blue++; } return red > 100 && blue > 100; })).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('@notebook Annotate never opens an existing notebook or file, even one the file list does not show', async ({ page }) => {
  const f = await fixture(page);
  try {
    await openFile(page, 'docs/brief.pdf'); await pdfReady(page, 'Page 1 of 3');
    fs.writeFileSync(path.join(f.root, 'docs/taken.crnb'), 'Existing owner file');
    await page.getByRole('button', { name: 'Annotate' }).click();
    await page.getByLabel('Notebook path').fill('docs/taken.crnb');
    await page.getByRole('button', { name: 'Create notebook' }).click();
    await expect(page.locator('.dv-annotate-status')).toContainText(/already uses this path/);
    expect(fs.readFileSync(path.join(f.root, 'docs/taken.crnb'), 'utf8')).toBe('Existing owner file');
    expect(listNotebooks(f.root).length).toBe(0);
    await expect(page.locator('dialog.notebook-dialog[open]')).toHaveCount(0);
  } finally { await f.close(); }
});
