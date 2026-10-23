import test from 'node:test';
import assert from 'node:assert/strict';
import { fitFrame, manualFrame, frameFromScroll, focalScroll, viewportKey, rememberViewport, readViewport, wholeViewport, annotationPath, annotationTitle, canvasBudget, clampZoom, VIEWPORT_LIMIT } from '../src/ui/document-viewer.mjs';

const memory = () => { const map = new Map(); return { map, getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); } }; };
const near = (actual, expected, epsilon = 1e-3) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);

test('fit framing matches Lisière: min ratio, centred, top aligned', () => {
  const tall = fitFrame({ width: 1000, height: 2000 }, { width: 800, height: 600 });
  near(tall.scale, 0.3); near(tall.width, 300); near(tall.height, 600); near(tall.x, 250); assert.equal(tall.y, 0);
  const wide = fitFrame({ width: 2000, height: 1000 }, { width: 800, height: 600 });
  near(wide.scale, 0.4); near(wide.width, 800); near(wide.height, 400); assert.equal(wide.x, 0); assert.equal(wide.y, 0);
  assert.equal(clampZoom(0.2), 1); assert.equal(clampZoom(99), 32); assert.equal(clampZoom(Number.NaN), 1);
});

test('manual framing round-trips zoom and centre across a resize', () => {
  const content = { width: 600, height: 800 }, first = { width: 800, height: 600 }, second = { width: 500, height: 700 };
  const saved = { mode: 'manual', zoom: 4, cx: 0.3, cy: 0.6 };
  const frame = manualFrame(saved, content, first);
  assert.equal(frame.zoom, 4);
  const back = frameFromScroll(frame, { width: frame.width, height: frame.height }, first, frame.zoom);
  near(back.cx, 0.3); near(back.cy, 0.6);
  const resized = manualFrame(back, content, second), again = frameFromScroll(resized, { width: resized.width, height: resized.height }, second, resized.zoom);
  assert.equal(again.zoom, 4); near(again.cx, 0.3); near(again.cy, 0.6);
  // a zoom keeps the point under the finger
  const before = { width: 450, height: 600 }, after = { width: 1800, height: 2400 }, point = { x: 400, y: 300 };
  const scroll = focalScroll({ scrollLeft: 0, scrollTop: 0 }, before, after, first, point);
  const fxBefore = (0 + point.x - Math.max(0, (first.width - before.width) / 2)) / before.width, fxAfter = (scroll.scrollLeft + point.x) / after.width;
  near(fxAfter, fxBefore, 1e-6); near((scroll.scrollTop + point.y) / after.height, point.y / before.height, 1e-6);
});

test('whole image resets to fit and is stored as fit', () => {
  const storage = memory(), key = viewportKey('p', 'docs/a.png', 'h1', 1);
  rememberViewport(storage, key, { mode: 'manual', zoom: 8, cx: 0.2, cy: 0.9 });
  assert.deepEqual(readViewport(storage, key), { mode: 'manual', zoom: 8, cx: 0.2, cy: 0.9 });
  assert.deepEqual(wholeViewport(storage, key), { mode: 'fit', zoom: 1 });
  assert.deepEqual(JSON.parse(storage.getItem(key)), { mode: 'fit' });
  assert.deepEqual(readViewport(storage, key), { mode: 'fit', zoom: 1 });
  assert.equal(readViewport(storage, 'missing'), null);
  assert.equal(readViewport({ getItem: () => '{broken' }, key), null);
  assert.deepEqual(canvasBudget(10000, 10000, 2), { width: 4000, height: 4000 });
  assert.deepEqual(canvasBudget(100, 200, 1), { width: 100, height: 200 });
});

test('viewport keys change with content hash and page; old keys are pruned at 200', () => {
  assert.notEqual(viewportKey('p', 'a.pdf', 'h1', 1), viewportKey('p', 'a.pdf', 'h2', 1));
  assert.notEqual(viewportKey('p', 'a.pdf', 'h1', 1), viewportKey('p', 'a.pdf', 'h1', 2));
  assert.notEqual(viewportKey('p', 'a.pdf', 'h1', 1), viewportKey('q', 'a.pdf', 'h1', 1));
  const storage = memory();
  for (let n = 0; n < VIEWPORT_LIMIT + 5; n++) rememberViewport(storage, viewportKey('p', 'a.pdf', 'h', n + 1), { mode: 'manual', zoom: 2, cx: 0.5, cy: 0.5 });
  const kept = [...storage.map.keys()].filter(key => key.startsWith('context-room-viewport:'));
  assert.equal(kept.length, VIEWPORT_LIMIT);
  for (let n = 1; n <= 5; n++) assert.equal(storage.getItem(viewportKey('p', 'a.pdf', 'h', n)), null);
  assert.ok(storage.getItem(viewportKey('p', 'a.pdf', 'h', 205)));
  rememberViewport(storage, viewportKey('p', 'a.pdf', 'h', 6), { mode: 'fit' });
  rememberViewport(storage, 'context-room-viewport:p:b.png:h:1', { mode: 'fit' });
  assert.ok(storage.getItem(viewportKey('p', 'a.pdf', 'h', 6)), 'a rewritten key becomes the newest');
  assert.equal(storage.getItem(viewportKey('p', 'a.pdf', 'h', 7)), null);
});

test('annotation path gets a free suffix and a page label', () => {
  assert.equal(annotationPath('docs/Spec.pdf', 3), 'docs/Spec – annotation p3.crnb');
  assert.equal(annotationPath('docs/photo.png', 0), 'docs/photo – annotation.crnb');
  assert.equal(annotationPath('scan.pdf', 1), 'scan – annotation p1.crnb');
  const taken = new Set(['docs/Spec – annotation p3.crnb', 'docs/Spec – annotation p3 2.crnb']);
  assert.equal(annotationPath('docs/Spec.pdf', 3, taken), 'docs/Spec – annotation p3 3.crnb');
  assert.equal(annotationTitle('docs/Spec.pdf', 3), 'Annotation · Spec.pdf · page 3');
  assert.equal(annotationTitle('docs/photo.png', 0), 'Annotation · photo.png');
});
