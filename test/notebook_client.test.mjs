import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotebookClient, MemoryNotebookStorage, notebookCacheKey } from '../src/notebook_client.mjs';
import { openNotebook, readNotebook, mutateNotebook, notebookReceipt } from '../src/notebooks.mjs';
const actor = { kind: 'human', id: 'tablet-test' };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-client-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  const scene = openNotebook(root, { id: 'board-test', path: 'docs/test.crnb', canWrite: () => true });
  let online = true, drop = false, sent = 0, sequence = 0;
  const transport = {
    open: async body => { if (!online) throw new TypeError('Offline'); return openNotebook(root, { ...body, canWrite: () => true }); },
    scene: async id => { if (!online) throw new TypeError('Offline'); return readNotebook(root, id); },
    receipt: async (id, op) => { if (!online) throw new TypeError('Offline'); return notebookReceipt(root, id, op); },
    mutate: async request => {
      if (!online) throw new TypeError('Offline'); sent++;
      const receipt = mutateNotebook(root, request, { actor, canWrite: () => true });
      if (drop) { drop = false; throw new TypeError('Response lost after canonical commit'); }
      return receipt;
    }
  };
  const storage = new MemoryNotebookStorage();
  const make = (resourceId = scene.resourceId, accountId = 'owner-test') => new NotebookClient({ storage, transport, scope: { serverId: 'mac-test', accountId, deviceId: 'tablet-test', resourceId }, actor, operationId: () => `op-${++sequence}` });
  return { root, scene, transport, storage, make, setOnline: value => online = value, dropNext: () => drop = true, sent: () => sent };
}
const put = (id, expectedRevision = 0) => ({ kind: 'put', id, expectedRevision, object: { id, type: 'ink', points: [[10, 10, .5], [20, 20, 1]], color: '#000000', strokeWidth: 2 } });

test('offline ink survives restart, same operation is acknowledged exactly once', async t => {
  const f = fixture(t), client = f.make(); await client.initialize(f.scene);
  f.setOnline(false); const op = await client.enqueue([put('stroke')]);
  await assert.rejects(client.flush(), /Offline/);
  assert.equal((await client.view()).status, 'pending'); client.close();
  const resumed = f.make(); assert.equal((await resumed.view()).document.objects.length, 1);
  assert.equal((await resumed.state()).operations[0].operationId, op);
  f.setOnline(true); await resumed.flush(); await resumed.flush();
  assert.equal(f.sent(), 1); assert.equal((await resumed.state()).operations.length, 0);
  assert.equal(readNotebook(f.root, 'board-test').document.objects.length, 1);
  assert.equal((await resumed.view()).accepted, false);
});

test('lost response is resolved by receipt before replay; stale responses never rewind', async t => {
  const f = fixture(t), c = f.make(); await c.initialize(f.scene);
  await c.enqueue([put('stroke')]); f.dropNext(); await assert.rejects(c.flush(), /Response lost/);
  await c.flush(); assert.equal(f.sent(), 1);
  await c.adopt(f.scene); assert.equal((await c.view()).document.objects.length, 1);
  await assert.rejects(c.adopt({ ...f.scene, resourceId: 'other' }), { code: 'notebook_response_scope' });
});

test('targeted conflict retains original ink and permits independent queued edits', async t => {
  const f = fixture(t), c = f.make(); await c.initialize(f.scene);
  const op = await c.enqueue([put('same')]); await c.enqueue([put('independent')]);
  mutateNotebook(f.root, { protocolVersion: 1, resourceId: 'board-test', locationRevision: f.scene.locator.revision, operationId: 'other-client', edits: [put('same')] }, { actor: { kind: 'agent', id: 'agent-test' }, canWrite: () => true });
  await c.flush(); const state = await c.state();
  assert.equal(state.operations.length, 1); assert.equal(state.operations[0].state, 'conflict');
  assert.deepEqual(state.operations[0].request.edits, [put('same')]);
  assert.equal(readNotebook(f.root, 'board-test').document.objects.length, 2);
  await c.resolveConflict(op, { edits: [put('recovered')] }); await c.flush();
  assert.equal(readNotebook(f.root, 'board-test').document.objects.length, 3);
  assert.equal((await c.exportRecovery()).metadata.recovery.length, 1);
});

test('two local clients cannot overwrite one another outbox; namespaces isolate accounts', async t => {
  const f = fixture(t), a = f.make(), b = f.make(); await a.initialize(f.scene);
  await Promise.all([a.enqueue([put('one')]), b.enqueue([put('two')])]);
  assert.equal((await a.state()).operations.length, 2);
  assert.equal((await f.make('board-test', 'another-account').state()).snapshot, null);
  await Promise.all([a.flush(), b.flush()]);
  assert.equal(readNotebook(f.root, 'board-test').document.objects.length, 2);
  assert.equal((await a.state()).operations.length, 0);
  assert.notEqual(notebookCacheKey(a.scope), notebookCacheKey({ ...a.scope, serverId: 'another-mac' }));
});

test('offline creation binds exact path and id; occupied destination never overwrites ink', async t => {
  const f = fixture(t), c = f.make('offline-book');
  await c.createOffline({ path: 'docs/offline.crnb', title: 'Offline notebook' });
  await c.enqueue([put('local')]); await c.flush();
  assert.equal(readNotebook(f.root, 'offline-book').document.objects.length, 1);
  const occupied = f.make('collision');
  await occupied.createOffline({ path: 'docs/test.crnb', title: 'Occupied' }); await occupied.enqueue([put('kept')]);
  await assert.rejects(occupied.flush(), { code: 'notebook_creation_conflict' });
  assert.equal((await occupied.view()).document.objects[0].id, 'kept');
  assert.equal(readNotebook(f.root, 'board-test').document.objects.length, 0);
});

test('untrusted or stale acknowledgement cannot mark local operations complete', async t => {
  const f = fixture(t), c = f.make(); await c.initialize(f.scene); await c.enqueue([put('kept')]);
  f.transport.mutate = async () => ({ status: 'confirmed', resourceId: 'other', operationId: 'different', sequence: 1 });
  await assert.rejects(c.flush(), { code: 'notebook_receipt_invalid' });
  assert.equal((await c.state()).operations.length, 1);
  assert.equal((await c.view()).document.objects[0].id, 'kept');
});

test('storage failure is visible and never labelled saved', async t => {
  const f = fixture(t), c = f.make(); await c.initialize(f.scene);
  const original = f.storage.commit.bind(f.storage);
  f.storage.commit = async () => { throw Object.assign(new Error('Disk full'), { code: 'quota' }); };
  await assert.rejects(c.enqueue([put('unsaved')]), /Disk full/);
  f.storage.commit = original;
  assert.equal((await c.state()).operations.length, 0);
});
