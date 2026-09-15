import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyNotebook } from '../src/notebook_protocol.mjs';
import { importNotebookDraft, readNotebook, openNotebook, mutateNotebook, freezeNotebook, readFrozenNotebook, NOTEBOOK_STORE } from '../src/notebooks.mjs';
const canWrite = rel => rel.startsWith('docs/') && rel.endsWith('.crnb');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-working-import-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actor = { kind: 'import', id: 'original-drawing' };
  const input = { path: 'docs/Ideas.crnb', requestId: 'snapshot-import', sourceRevision: 'a'.repeat(64), tombstones: { erased: 3 },
    document: { ...emptyNotebook('original-board', 'Original ideas'), revision: 7,
      objects: [{ id: 'old-shape', type: 'rect', x: 100, y: 100, width: 90, height: 50, revision: 7, createdBy: actor, updatedBy: actor }] } };
  return { root, input, apply: () => importNotebookDraft(root, input, { canWrite }) };
}
test('import retains identity and deletion revisions as editable work without creating or accepting an ordinary file', t => {
  const { root, input, apply } = fixture(t), scene = apply();
  assert.equal(scene.resourceId, 'original-board'); assert.equal(scene.revision, 7); assert.equal(scene.accepted, false);
  assert.equal(scene.tombstones.erased, 3); assert.deepEqual(scene.document, input.document);
  assert.equal(fs.existsSync(path.join(root, input.path)), false);
  assert.equal(fs.existsSync(path.join(root, '.context-room/document-assets/accepted.json')), false);
  assert.equal(openNotebook(root, { path: input.path, canWrite }).resourceId, scene.resourceId);
  assert.throws(() => mutateNotebook(root, { protocolVersion: 1, resourceId: scene.resourceId, operationId: 'stale-erasure-replay', locationRevision: scene.locator.revision,
    edits: [{ kind: 'put', id: 'erased', expectedRevision: 0, object: { type: 'rect' } }] }, { actor: { kind: 'human', id: 'owner' }, canWrite }), { code: 'notebook_object_conflict' });
});
test('an import preview leaves no lock, header or directory and cannot bypass occupied destinations', t => {
  const { root, input, apply } = fixture(t), before = fs.readdirSync(root);
  const plan = importNotebookDraft(root, input, { canWrite, preview: true });
  assert.equal(plan.preview, true); assert.equal(plan.replayed, false); assert.deepEqual(fs.readdirSync(root), before);
  apply(); const repeated = importNotebookDraft(root, input, { canWrite, preview: true });
  assert.equal(repeated.replayed, true); assert.equal(repeated.preview, true);
});
test('a repeated import preserves later human changes and freezes them through the normal notebook workflow', t => {
  const { root, apply } = fixture(t), scene = apply(), actor = { kind: 'human', id: 'owner' };
  mutateNotebook(root, { protocolVersion: 1, resourceId: scene.resourceId, operationId: 'later-human-edit', locationRevision: scene.locator.revision,
    edits: [{ kind: 'patch', id: 'old-shape', expectedRevision: 7, patch: { x: 250 } }] }, { actor, canWrite });
  const repeated = apply(); assert.equal(repeated.replayed, true); assert.equal(repeated.revision, 8); assert.equal(repeated.document.objects[0].x, 250);
  freezeNotebook(root, { resourceId: scene.resourceId, operationId: 'review-import', expectedRevision: 8, locationRevision: scene.locator.revision }, { actor, canWrite });
  assert.equal(readFrozenNotebook(root, scene.resourceId, 'review-import').document.objects[0].x, 250);
  assert.equal(readNotebook(root, scene.resourceId).accepted, false);
});
test('occupied paths, reused identities, changed sources and invalid provenance are refused without replacement', t => {
  const { root, input, apply } = fixture(t);
  fs.mkdirSync(path.join(root, 'docs')); fs.writeFileSync(path.join(root, input.path), 'Existing original bytes');
  assert.throws(apply, { code: 'notebook_location_conflict' }); assert.equal(fs.readFileSync(path.join(root, input.path), 'utf8'), 'Existing original bytes');
  fs.unlinkSync(path.join(root, input.path)); apply();
  assert.throws(() => importNotebookDraft(root, { ...input, sourceRevision: 'b'.repeat(64) }, { canWrite }), { code: 'notebook_location_conflict' });
  assert.throws(() => importNotebookDraft(root, { ...input, document: { ...input.document, objects: [{ ...input.document.objects[0], createdBy: { kind: 'agent', id: 'pretend' } }] } }, { canWrite }), /import provenance/);
  assert.throws(() => importNotebookDraft(root, { ...input, tombstones: { 'old-shape': 2 } }, { canWrite }), /deletion/);
  assert.throws(() => importNotebookDraft(root, input), { code: 'notebook_path_scope' });
});
test('an interrupted response after atomic header publication replays the original import exactly once', t => {
  const { root, input, apply } = fixture(t), originalLink = fs.linkSync;
  let interrupted = false;
  fs.linkSync = (from, to, ...rest) => { originalLink(from, to, ...rest); if (String(to).endsWith('/header.json') && !interrupted) { interrupted = true; throw new Error('Injected lost import acknowledgement'); } };
  try { assert.throws(apply, /lost import acknowledgement/); } finally { fs.linkSync = originalLink; }
  const repeated = apply(); assert.equal(repeated.replayed, true); assert.deepEqual(repeated.document, input.document);
  assert.deepEqual(fs.readdirSync(path.join(root, NOTEBOOK_STORE, 'resources')), ['original-board']);
});
test('inherited JavaScript names remain ordinary imported deletion identities and keep their actual author', t => {
  const { root, input } = fixture(t), actor = { kind: 'human', id: 'first-owner' };
  input.tombstones.valueOf = 5;
  const imported = importNotebookDraft(root, input, { canWrite });
  const edit = (operationId, edits, author = actor) => mutateNotebook(root, { protocolVersion: 1, resourceId: imported.resourceId,
    operationId, locationRevision: imported.locator.revision, edits }, { actor: author, canWrite });
  const object = { id: 'valueOf', type: 'rect', x: 0, y: 0, width: 10, height: 10 };
  edit('restore-imported-deletion', [{ kind: 'put', id: 'valueOf', expectedRevision: 5, object }]);
  assert.deepEqual(readNotebook(root, imported.resourceId).document.objects.find(item => item.id === 'valueOf').createdBy, actor);
  edit('delete-restored', [{ kind: 'delete', id: 'valueOf', expectedRevision: 6 }]);
  edit('second-owner-restores', [{ kind: 'put', id: 'valueOf', expectedRevision: 7, object }], { kind: 'human', id: 'second-owner' });
  const restored = readNotebook(root, imported.resourceId).document.objects.find(item => item.id === 'valueOf');
  assert.equal(restored.revision, 8); assert.deepEqual(restored.createdBy, actor); assert.equal(restored.updatedBy.id, 'second-owner');
  edit('ordinary-inherited-name', [{ kind: 'put', id: 'toString', expectedRevision: 0, object: { ...object, id: 'toString' } }]);
  assert.deepEqual(readNotebook(root, imported.resourceId).document.objects.find(item => item.id === 'toString').createdBy, actor);
});
test('a concurrent ordinary file creation or altered original header remains a visible recovery conflict', t => {
  const { root, input, apply } = fixture(t), originalLink = fs.linkSync;
  fs.mkdirSync(path.join(root, 'docs'));
  fs.linkSync = (from, to, ...rest) => { originalLink(from, to, ...rest); if (String(to).endsWith('/header.json')) fs.writeFileSync(path.join(root, input.path), 'Concurrent newer file'); };
  try { assert.throws(apply, { code: 'notebook_external_conflict' }); } finally { fs.linkSync = originalLink; }
  assert.throws(apply, { code: 'notebook_external_conflict' }); assert.equal(fs.readFileSync(path.join(root, input.path), 'utf8'), 'Concurrent newer file');
  fs.unlinkSync(path.join(root, input.path));
  const headerPath = path.join(root, NOTEBOOK_STORE, 'resources/original-board/header.json'), header = JSON.parse(fs.readFileSync(headerPath));
  header.document.objects[0].x = 999; fs.writeFileSync(headerPath, JSON.stringify(header));
  assert.throws(apply, { code: 'notebook_location_conflict' }); assert.equal(readNotebook(root, input.document.id).document.objects[0].x, 999);
});
