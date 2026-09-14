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

test('native journal replay after process death is atomic with the queued edit and its gesture', async t => {
  const f = fixture(t), c = f.make(); await c.initialize(f.scene);
  const command = { channel: 'native-journal', sequence: 1, id: 'native-command-1' };
  await c.enqueue([put('stroke')], { gestureId: 'gesture', nativeCommand: command });
  c.close(); // Android dies after the IDB commit, before clearing its write-ahead head.
  const resumed = f.make();
  await resumed.enqueue([put('stroke')], { gestureId: 'gesture', nativeCommand: command });
  assert.equal((await resumed.state()).operations.length, 1);
  assert.equal((await resumed.state()).metadata.gestureHistory.undo.length, 1);
  await resumed.flush();
  // Replay remains safe after the small recent-network-receipt index is replaced.
  await resumed.change(state => ({ metadata: { ...state.metadata, acknowledgements: [] } }));
  await resumed.enqueue([put('stroke')], { gestureId: 'gesture', nativeCommand: command });
  assert.equal((await resumed.state()).operations.length, 0);
  assert.equal(f.sent(), 1);
  assert.equal((await resumed.view()).document.objects[0].revision, 1);
});

test('native undo replay does not undo the next gesture, and journal gaps or substitutions fail closed', async t => {
  const f = fixture(t), c = f.make(); await c.initialize(f.scene);
  const native = sequence => ({ channel: 'native-journal', sequence, id: `native-command-${sequence}` });
  await c.enqueue([put('first')], { gestureId: 'first', nativeCommand: native(1) });
  await c.enqueue([put('second')], { gestureId: 'second', nativeCommand: native(2) });
  await c.replayGesture('undo', { nativeCommand: native(3) });
  await c.replayGesture('undo', { nativeCommand: native(3) });
  assert.deepEqual((await c.view()).document.objects.map(o => o.id), ['first']);
  await assert.rejects(c.enqueue([put('gap')], { nativeCommand: native(5) }), { code: 'notebook_native_command' });
  await assert.rejects(c.replayGesture('redo', { nativeCommand: { ...native(3), id: 'replaced' } }), { code: 'notebook_native_command' });
  await c.replayGesture('redo', { nativeCommand: native(4) });
  assert.deepEqual((await c.view()).document.objects.map(o => o.id), ['first', 'second']);
  assert.equal((await c.exportRecovery()).metadata.nativeChannels['native-journal'].sequence, 4);
});

test('native command watermark is not advanced when durable storage fails', async t => {
  const f = fixture(t), c = f.make(); await c.initialize(f.scene);
  const commit = f.storage.commit.bind(f.storage);
  f.storage.commit = async () => { throw new Error('Disk full'); };
  const nativeCommand = { channel: 'native-journal', sequence: 1, id: 'native-command-1' };
  await assert.rejects(c.enqueue([put('stroke')], { nativeCommand }), /Disk full/);
  f.storage.commit = commit;
  assert.equal((await c.state()).metadata.nativeChannels, undefined);
  await c.enqueue([put('stroke')], { nativeCommand });
  assert.equal((await c.state()).operations.length, 1);
});

test('batched offline replay keeps individual receipts and survives a lost whole response', async t => {
  const f = fixture(t), c = f.make(); await c.initialize(f.scene);
  let batches = 0;
  f.transport.batch = async body => {
    batches++;
    const results = body.operations.map(request => ({ operationId: request.operationId, receipt: mutateNotebook(f.root, request, { actor, canWrite: () => true }) }));
    if (batches === 1) throw new Error('Lost batch response');
    return { protocolVersion: 1, resourceId: body.resourceId, results, snapshot: readNotebook(f.root, body.resourceId) };
  };
  for (let n = 0; n < 8; n++) await c.enqueue([put(`stroke-${n}`)], { gestureId: `gesture-${n}` });
  await assert.rejects(c.flush(), /Lost batch response/);
  assert.equal((await c.state()).operations.length, 8);
  assert.equal(readNotebook(f.root, f.scene.resourceId).sequence, 8);
  c.close(); const resumed = f.make(); await resumed.flush();
  assert.equal((await resumed.state()).operations.length, 0);
  assert.equal(readNotebook(f.root, f.scene.resourceId).sequence, 8);
  assert.equal((await resumed.view()).document.objects.length, 8);
  assert.equal(batches, 2); assert.equal(f.sent(), 0);
});

test('a batch cannot acknowledge the wrong resource or hide a targeted conflict', async t => {
  const f = fixture(t), c = f.make(); await c.initialize(f.scene);
  await c.enqueue([put('one')]); await c.enqueue([put('two')]);
  f.transport.batch = async body => ({ protocolVersion: 1, resourceId: 'different', results: body.operations.map(op => ({ operationId: op.operationId })), snapshot: f.scene });
  await assert.rejects(c.flush(), { code: 'notebook_receipt_invalid' });
  assert.equal((await c.state()).operations.length, 2);
  f.transport.batch = async body => {
    const second = body.operations[1];
    return { protocolVersion: 1, resourceId: body.resourceId, results: [
      { operationId: body.operations[0].operationId, error: { status: 409, code: 'notebook_object_conflict', message: 'The object changed.' } },
      { operationId: second.operationId, receipt: mutateNotebook(f.root, second, { actor, canWrite: () => true }) },
    ], snapshot: readNotebook(f.root, body.resourceId) };
  };
  await c.flush();
  assert.equal((await c.state()).operations.length, 1); assert.equal((await c.state()).operations[0].state, 'conflict');
  assert.deepEqual(readNotebook(f.root, f.scene.resourceId).document.objects.map(o => o.id), ['two']);
});

test('a revoked batch keeps every original gesture in explicit recoverable conflict', async t => {
  const f = fixture(t), c = f.make(); await c.initialize(f.scene);
  await c.enqueue([put('one')]); await c.enqueue([put('two')]);
  f.transport.batch = async () => { throw Object.assign(new Error('Device revoked'), { status: 403, code: 'device_unauthorized' }); };
  await assert.rejects(c.flush(), /Device revoked/);
  const recovery = await c.exportRecovery();
  assert.equal(recovery.operations.length, 2); assert.ok(recovery.operations.every(op => op.state === 'conflict'));
  assert.equal(readNotebook(f.root, f.scene.resourceId).document.objects.length, 0);
});
