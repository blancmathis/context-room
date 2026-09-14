import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotebookClient, MemoryNotebookStorage, notebookBrowserIdentity } from '../src/notebook_client.mjs';
import { NotebookStroke } from '../src/notebook_gestures.mjs';
import { notebookInkOutline, notebookInkRadius } from '../src/notebook_ink.mjs';
import { notebookSvg } from '../src/notebook_render.mjs';
import { openNotebook, readNotebook, mutateNotebook, notebookReceipt, addNotebookAsset } from '../src/notebooks.mjs';
const actor = { kind: 'human', id: 'human-test' }, agent = { kind: 'agent', id: 'agent-test' };
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-gesture-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs')); const initial = openNotebook(root, { id: 'board', path: 'docs/example.crnb', canWrite: () => true });
  const storage = new MemoryNotebookStorage(); let number = 0;
  const transport = { scene: async () => readNotebook(root, 'board'), receipt: async (id, op) => notebookReceipt(root, id, op),
    mutate: async request => mutateNotebook(root, request, { actor, canWrite: () => true }), asset: async request => addNotebookAsset(root, request, { actor, canWrite: () => true }) };
  const make = () => new NotebookClient({ storage, transport, scope: { serverId: 'mac-test', accountId: 'owner-test', deviceId: actor.id, resourceId: 'board' }, actor, operationId: () => `op-${++number}` });
  const external = edits => mutateNotebook(root, { protocolVersion: 1, resourceId: 'board', operationId: `external-${++number}`, locationRevision: initial.locator.revision, edits }, { actor: agent, canWrite: () => true });
  return { root, initial, storage, transport, make, external };
}
const box = id => ({ kind: 'put', id, expectedRevision: 0, object: { id, type: 'rect', x: 10, y: 10, width: 40, height: 30 } });

test('continuous ink is durable before pen-up; segmented gesture undo survives restart and preserves independent agent work', async t => {
  const f = setup(t), client = f.make(); await client.initialize(f.initial);
  let n = 0; const stroke = new NotebookStroke({ enqueue: (...args) => client.enqueue(...args), id: () => `stroke-${++n}`, segmentPoints: 3 });
  await stroke.append([[0, 0, .2]]); assert.equal((await client.state()).operations.length, 1);
  await Promise.all([stroke.append([[1, 1, .4], [2, 2, .6]]), stroke.append([[3, 3, .8], [4, 4, 1], [5, 5, .8], [6, 6, .5]])]);
  await stroke.finish(); assert.equal(stroke.recovery().unsavedSamples.length, 0);
  const local = await client.view(); assert.equal(local.document.objects.length, 3);
  assert.ok(local.document.objects.every(object => object.points.length <= 3));
  await client.flush(); f.external([box('independent-agent')]); await client.refresh(); client.close();
  const resumed = f.make(); await resumed.replayGesture('undo'); await resumed.flush();
  assert.deepEqual(readNotebook(f.root, 'board').document.objects.map(object => object.id), ['independent-agent']);
  await resumed.replayGesture('redo'); await resumed.flush();
  assert.equal(readNotebook(f.root, 'board').document.objects.length, 4);
  assert.equal(readNotebook(f.root, 'board').document.objects.find(object => object.id === 'independent-agent').createdBy.kind, 'agent');
  assert.equal((await resumed.view()).accepted, false);
});

test('undo is exact CAS, not an overwrite of a newer agent transformation', async t => {
  const f = setup(t), client = f.make(); await client.initialize(f.initial); await client.enqueue([box('shared-object')], { gestureId: 'gesture' }); await client.flush();
  f.external([{ kind: 'patch', id: 'shared-object', expectedRevision: 1, patch: { x: 99 } }]); await client.refresh();
  await assert.rejects(client.replayGesture('undo'), { code: 'notebook_object_conflict' });
  assert.equal((await client.state()).metadata.gestureHistory.undo.length, 1); assert.equal(readNotebook(f.root, 'board').document.objects[0].x, 99);
});

test('lock undo uses the explicit unlock operation; redo locks only the selected object', async t => {
  const f = setup(t), client = f.make(); await client.initialize(f.initial); await client.enqueue([box('locked-object')], { gestureId: 'create' });
  await client.enqueue([{ kind: 'patch', id: 'locked-object', expectedRevision: 1, patch: { locked: true } }], { gestureId: 'lock' });
  await client.replayGesture('undo'); assert.equal((await client.view()).document.objects[0].locked, false);
  await client.replayGesture('redo'); assert.equal((await client.view()).document.objects[0].locked, true);
  await client.flush(); assert.equal(readNotebook(f.root, 'board').document.objects[0].locked, true);
});

test('failed disk writes retain only the unreached sample suffix for explicit recovery', async () => {
  let calls = 0; const stroke = new NotebookStroke({ id: () => `sample-${calls}`, segmentPoints: 3, enqueue: async () => { calls++; if (calls === 3) throw new Error('Disk full'); } });
  await assert.rejects(stroke.append([[0, 0, .5], [1, 1, .5], [2, 2, .5], [3, 3, .5]]), /Disk full/);
  await assert.rejects(stroke.finish(), /Disk full/);
  assert.deepEqual(stroke.recovery().unsavedSamples, [[[3, 3, .5]]]);
});

test('simultaneous first tabs resolve one persistent browser identity', async () => {
  const storage = new MemoryNotebookStorage(); const identities = await Promise.all(Array.from({ length: 8 }, () => notebookBrowserIdentity(storage)));
  assert.equal(new Set(identities).size, 1); assert.equal(await notebookBrowserIdentity(storage), identities[0]);
  assert.equal((await storage.list()).length, 0);
});

test('UI observer failure cannot turn a committed gesture into a failed disk write', async t => {
  const f = setup(t), client = f.make(); await client.initialize(f.initial); client.onChange = () => { throw new Error('Renderer unavailable'); };
  const id = await client.enqueue([box('retained')]); assert.equal((await client.state()).operations[0].operationId, id);
  assert.equal(client.observerError.message, 'Renderer unavailable');
});

test('pressure changes the exported geometry; SVG origin includes agent edits of human objects', async t => {
  assert.ok(notebookInkRadius([0, 0, .1], 10) < notebookInkRadius([0, 0, .9], 10));
  const outline = notebookInkOutline([[0, 0, 0], [10, 0, 1]], 10); assert.equal(outline[0][1], 1); assert.equal(outline[1][1], 5);
  const f = setup(t), client = f.make(); await client.initialize(f.initial);
  await client.enqueue([{ kind: 'put', id: 'pressure', expectedRevision: 0, object: { type: 'ink', points: [[0, 0, 0], [10, 0, 1]], strokeWidth: 10 } }]); await client.flush();
  f.external([{ kind: 'patch', id: 'pressure', expectedRevision: 1, patch: { color: '#111111' } }]);
  const svg = notebookSvg(readNotebook(f.root, 'board').document, { showOrigins: true });
  assert.match(svg, /<polygon/); assert.match(svg, /changed by agent/); assert.match(svg, />agent<\/text>/); assert.doesNotMatch(svg, /<script|https?:\/\/[^w]/);
});
