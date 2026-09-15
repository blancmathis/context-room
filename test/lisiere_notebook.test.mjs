import test from 'node:test';
import assert from 'node:assert/strict';
import { convertLisiereBoard } from '../src/lisiere_notebook.mjs';
import { notebookHash } from '../src/notebook_io.mjs';
import { notebookSvg } from '../src/notebook_render.mjs';
import { notebookNativeObject, notebookObjectFromNative } from '../src/notebook_native.mjs';
import { normalizeNotebookObject } from '../src/notebook_protocol.mjs';
import { notebookInkRadius } from '../src/notebook_ink.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const hash = notebookHash(png);
function fixture() {
  const board = { id: 'original:board', title: 'Original ideas', project: null, directory: null, anchor: null, revision: 9 };
  const row = (value, revision = 7) => ({ board: board.id, id: value.id, revision, data: JSON.stringify({ ...value, revision, actor: 'original-device' }) });
  const rows = [
    row({ id: 'return', type: 'connector', from: 'shape:one', to: 'second', fromSide: 'left', toSide: 'left', route: 'outside-left', routeOffset: 60, z: 3 }),
    row({ id: 'shape:one', type: 'rect', x: 200, y: 100, w: 100, h: 60 }),
    row({ id: 'second', type: 'ellipse', x: 200, y: 300, w: 100, h: 60 }),
    row({ id: 'ink', type: 'ink', width: 20, points: [[10, 20, .1], [30, 40], [50, 60, 1, 100]] }),
    row({ id: 'constructor', type: 'text', x: 350, y: 100, text: 'First\nSecond' }),
    row({ id: 'arrow', type: 'arrow', x: 15, y: 25, w: -10, h: 40 }),
    row({ id: 'photo', type: 'image', x: 10, y: 10, w: 40, h: 20, assetId: hash }),
    row({ id: 'photo-copy', type: 'image', x: 60, y: 10, w: 40, h: 20, assetId: hash }),
    { board: board.id, id: 'erased', revision: 9, data: null },
  ];
  return { board, rows, row };
}
test('Mac conversion preserves editable IDs, deleted revisions, pen samples, images, ordering and native presentation', () => {
  const { board, rows } = fixture(), before = JSON.stringify(rows); let reads = 0;
  const result = convertLisiereBoard(board, rows, id => { assert.equal(id, hash); reads++; return png; });
  const repeated = convertLisiereBoard(board, rows, () => png);
  assert.deepEqual(result, repeated); assert.equal(result.accepted, false); assert.equal(reads, 1);
  assert.equal(result.document.objects.length, 8); assert.equal(result.document.objects.at(-1).id, 'return');
  const mapped = new Map(result.idMapping.map(item => [item.sourceId, item.objectId]));
  assert.equal(mapped.get('second'), 'second'); assert.match(mapped.get('constructor'), /^legacy-/); assert.match(mapped.get('shape:one'), /^legacy-/);
  assert.equal(result.tombstones.erased, 9);
  const object = id => result.document.objects.find(value => value.id === mapped.get(id));
  assert.deepEqual(object('ink').points, [[10, 20, .1], [30, 40, 1], [50, 60, 1, 100]]);
  assert.equal(object('ink').pressureCurve, 'linear'); assert.equal(notebookInkRadius([0, 0, .1], 20, 'linear'), 1.5);
  assert.ok(Math.abs(notebookInkRadius([0, 0, .1], 20) - 2.8) < 1e-10);
  assert.match(notebookSvg(result.document), /cx="10" cy="20" r="1.5"/);
  assert.equal(object('constructor').fontSize, 22); assert.equal(object('constructor').lineHeight, 1.4); assert.equal(object('constructor').y, 122);
  assert.equal(object('constructor').width, 160); assert.equal(object('constructor').height, 60);
  assert.equal(object('arrow').x2, 5); assert.equal(object('arrow').y2, 65);
  assert.deepEqual(Buffer.from(result.document.assets[hash].data, 'base64'), png);
  assert.match(notebookSvg(result.document), /d="M200 130 L140 130 L140 330 L200 330"/);
  for (const value of result.document.objects) assert.deepEqual(notebookObjectFromNative(notebookNativeObject(value)), normalizeNotebookObject(value));
  assert.equal(JSON.stringify(rows), before);
});
test('generated legacy IDs cannot collide with an already valid source ID', () => {
  const { board, row } = fixture(), expected = `legacy-${notebookHash(['object', board.id, 'bad:id', 0])}`;
  const result = convertLisiereBoard(board, [row({ id: 'bad:id', type: 'rect' }), row({ id: expected, type: 'rect' })], () => png);
  assert.equal(new Set(result.document.objects.map(value => value.id)).size, 2);
  assert.equal(result.idMapping.find(item => item.sourceId === expected).objectId, expected);
  assert.notEqual(result.idMapping.find(item => item.sourceId === 'bad:id').objectId, expected);
});
test('missing endpoints/assets, stale object versions, cyclic graphs and oversized strokes refuse conversion without truncation', () => {
  const { board, row } = fixture();
  const long = row({ id: 'long', type: 'ink', points: Array.from({ length: 16385 }, (_, index) => [index, 0, 1]) }), saved = long.data;
  assert.throws(() => convertLisiereBoard(board, [long]), /point limit/); assert.equal(long.data, saved);
  assert.throws(() => convertLisiereBoard(board, [row({ id: 'c', type: 'connector', from: 'absent', to: 'also-absent' })]), /endpoint/);
  assert.throws(() => convertLisiereBoard(board, [row({ id: 'a', type: 'connector', from: 'b', to: 'b' }), row({ id: 'b', type: 'connector', from: 'a', to: 'a' })]), /cyclic/);
  assert.throws(() => convertLisiereBoard(board, [row({ id: 'future', type: 'rect' }, 10)]), /revision/);
  assert.throws(() => convertLisiereBoard(board, [row({ id: 'image', type: 'image', assetId: hash })], () => Buffer.from('different')), /asset changed/);
  const unknown = Buffer.from('unsupported preserved original raster'), unknownHash = notebookHash(unknown);
  assert.throws(() => convertLisiereBoard(board, [row({ id: 'image', type: 'image', assetId: unknownHash })], () => unknown), /explicit conversion/);
});
