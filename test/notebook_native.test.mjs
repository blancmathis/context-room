import test from 'node:test';
import assert from 'node:assert/strict';
import { notebookNativeObject, notebookObjectFromNative, notebookNativeEdits } from '../src/notebook_native.mjs';
import { normalizeNotebookObject } from '../src/notebook_protocol.mjs';

test('native projection preserves editable geometry, style, pressure and references on round-trip', () => {
  const variants = [
    { type: 'rect', width: 150, height: 75, rotation: 15, fill: '#ffffff', color: '#113355', locked: true },
    { type: 'ellipse', width: 40, height: 60, strokeWidth: 8 },
    { type: 'line', x2: -80, y2: 90 }, { type: 'arrow', x2: -80, y2: -90 },
    { type: 'text', text: 'A\nB', fontSize: 22, width: 240, height: 60 },
    { type: 'image', asset: 'a'.repeat(64), width: 120, height: 80 },
    { type: 'connector', from: 'start', to: 'finish', width: 30, height: 20 },
    { type: 'ink', points: [[10,20,0],[30,40,1,123]], strokeWidth: 4 },
    { type: 'text', text: 'Default dimensions' }, { type: 'rect' },
  ];
  for (const [n, variant] of variants.entries()) {
    const value = normalizeNotebookObject({ id: `object-${n}`, x: 20, y: 30, strokeWidth: 3, ...variant });
    const native = notebookNativeObject(value, n);
    assert.equal(native.width, value.strokeWidth);
    const restored = notebookObjectFromNative(native);
    assert.deepEqual(restored, value);
  }
});

test('native edits keep expected revisions and cannot smuggle alternate authors or unsupported operations', () => {
  const object = notebookNativeObject({ id: 'box', type: 'rect', x: 1, y: 2, width: 40, height: 80, strokeWidth: 3, createdBy: { kind: 'human', id: 'real' } });
  object.w = 99; object.canonical.updatedBy = { kind: 'agent', id: 'spoofed' };
  const edit = notebookNativeEdits([{ id: 'box', expectedRevision: 7, value: object }])[0];
  assert.equal(edit.object.width, 99); assert.equal(edit.expectedRevision, 7);
  assert.equal(edit.object.createdBy, undefined); assert.equal(edit.object.updatedBy, undefined);
  assert.deepEqual(notebookNativeEdits([{ id: 'stroke', kind: 'append', expectedRevision: 8, points: [[1,2,.5]] }]), [{ kind: 'append', id: 'stroke', expectedRevision: 8, points: [[1,2,.5]] }]);
  assert.throws(() => notebookNativeEdits([]));
});
