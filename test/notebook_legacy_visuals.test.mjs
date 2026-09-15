import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNotebookObject, emptyNotebook } from '../src/notebook_protocol.mjs';
import { notebookConnectorRoute, notebookObjectBounds } from '../src/notebook_geometry.mjs';
import { notebookNativeObject, notebookObjectFromNative } from '../src/notebook_native.mjs';
import { encodeNotebook, decodeNotebook } from '../src/notebooks.mjs';
import { notebookSvg } from '../src/notebook_render.mjs';
import { NotebookCanvas } from '../src/ui/notebook-canvas.mjs';

function objects() {
  const values = [
    { id: 'upper', type: 'rect', x: 200, y: 100, width: 120, height: 50 },
    { id: 'lower', type: 'rect', x: 200, y: 300, width: 120, height: 50 },
    { id: 'return', type: 'connector', from: 'upper', to: 'lower', fromSide: 'left', toSide: 'left', route: 'outside-left', routeOffset: 48 },
    { id: 'label', type: 'text', x: 400, y: 122, width: 160, height: 100, fontSize: 22, lineHeight: 1.4, text: 'First\nSecond' },
  ];
  return values.map(value => ({ ...value, revision: 1, createdBy: { kind: 'import', id: 'old-drawing' }, updatedBy: { kind: 'import', id: 'old-drawing' } }));
}
test('routed connectors retain sides and exact route through normalization, file round-trip and native editing', () => {
  const values = objects(), connector = values[2];
  assert.deepEqual(notebookConnectorRoute(connector, values), [[200, 125], [152, 125], [152, 325], [200, 325]]);
  assert.deepEqual(notebookObjectBounds(connector, values), { x: 151, y: 124, width: 50, height: 202 });
  const doc = { ...emptyNotebook('legacy-visuals'), revision: 1, objects: values };
  assert.deepEqual(decodeNotebook(encodeNotebook(doc)), doc);
  for (const item of values) assert.deepEqual(notebookObjectFromNative(notebookNativeObject(item)), normalizeNotebookObject(item));
  const moved = notebookObjectFromNative({ ...notebookNativeObject(connector), routeOffset: 96 });
  assert.equal(moved.routeOffset, 96); assert.equal(moved.fromSide, 'left'); assert.equal(moved.route, 'outside-left');
  assert.match(notebookSvg(doc), /d="M200 125 L152 125 L152 325 L200 325"/);
  assert.match(notebookSvg(doc), /dy="1.4em">Second/);
});
test('browser canvas follows the same route and text baselines without flattening objects', () => {
  const values = objects(), canvas = Object.create(NotebookCanvas.prototype), lines = [], text = [];
  canvas.byId = new Map(values.map(value => [value.id, value]));
  const context = { save() {}, restore() {}, beginPath() {}, stroke() {}, setLineDash(value) { assert.deepEqual(value, []); }, moveTo(x, y) { lines.push(['move', x, y]); }, lineTo(x, y) { lines.push(['line', x, y]); }, fillText(value, x, y) { text.push([value, x, y]); } };
  canvas.paintObject(context, values[2]);
  assert.deepEqual(lines.slice(0, 4), [['move', 200, 125], ['line', 152, 125], ['line', 152, 325], ['line', 200, 325]]);
  canvas.paintObject(context, values[3]);
  assert.deepEqual(text, [['First', 400, 122], ['Second', 400, 152.8]]);
  const native = notebookNativeObject(values[3]); assert.equal(native.y, 100); assert.equal(native.lineHeight, 1.4);
});
test('ports follow moved targets, while cyclic or deep connector graphs stop without exponential traversal', () => {
  const values = objects(); values[0].x = 280; values[0].width = -120;
  assert.deepEqual(notebookConnectorRoute(values[2], values), [[160, 125], [112, 125], [112, 325], [200, 325]]);
  const cyclic = [{ id: 'a', type: 'connector', from: 'b', to: 'b' }, { id: 'b', type: 'connector', from: 'a', to: 'a' }];
  assert.deepEqual(notebookConnectorRoute(cyclic[0], cyclic), []);
  const chain = [{ id: 'r', type: 'rect', x: 10, y: 10, width: 100, height: 50 }];
  for (let index = 0; index < 70; index++) chain.push({ id: `c${index}`, type: 'connector', from: index ? `c${index - 1}` : 'r', to: index ? `c${index - 1}` : 'r' });
  assert.deepEqual(notebookConnectorRoute(chain.at(-1), chain), []);
});
test('unknown sides/routes, unbounded offsets and invalid text spacing are refused', () => {
  const [, , connector, label] = objects();
  for (const fields of [{ fromSide: '__proto__' }, { toSide: 'url(x)' }, { route: 'unknown' }, { routeOffset: 0 }, { routeOffset: Infinity }, { routeOffset: 10001 }])
    assert.throws(() => normalizeNotebookObject({ ...connector, ...fields }), { code: 'notebook_connector' });
  for (const lineHeight of [0, -1, NaN, 9, '1.4']) assert.throws(() => normalizeNotebookObject({ ...label, lineHeight }), { code: 'notebook_text' });
});
