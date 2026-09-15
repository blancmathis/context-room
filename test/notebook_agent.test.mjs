import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotebookAgentContext, NOTEBOOK_AGENT_TOOL } from '../src/notebook_agent.mjs';
import { openNotebook, mutateNotebook, readNotebook } from '../src/notebooks.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-agent-')));
  const root = path.join(base, 'original'), other = path.join(base, 'other'); fs.mkdirSync(root); fs.mkdirSync(other);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  let permitted = true;
  const canWrite = value => permitted && value === 'docs/Scene.crnb';
  const scene = openNotebook(root, { path: 'docs/Scene.crnb', id: 'original', canWrite });
  const foreign = openNotebook(other, { path: 'docs/Scene.crnb', id: 'other', canWrite });
  const context = new NotebookAgentContext({ root, resourceId: scene.resourceId, locationRevision: scene.locator.revision, sessionId: 'conversation-one', canRead: canWrite, canWrite });
  return { base, root, other, scene, foreign, context, revoke: () => { permitted = false; } };
}

test('agent context remains in the original physical project and cannot accept or redirect', async t => {
  const f = fixture(t), input = { action: 'edit', edits: [{ kind: 'put', id: 'agent-shape', expectedRevision: 0, object: { type: 'rect', x: 20, y: 20, width: 100, height: 80 } }] };
  const call = { callId: 'call-one', turnId: 'turn-one' };
  const first = await f.context.call(NOTEBOOK_AGENT_TOOL.name, input, call);
  const replayed = await f.context.call(NOTEBOOK_AGENT_TOOL.name, input, call);
  assert.deepEqual(replayed, { ...first, replayed: true }); assert.equal(first.accepted, false);
  assert.equal(readNotebook(f.other, f.foreign.resourceId).document.objects.length, 0);
  assert.equal(readNotebook(f.root, f.scene.resourceId).document.objects[0].createdBy.kind, 'agent');
  assert.equal(fs.existsSync(path.join(f.root, 'docs/Scene.crnb')), false);
  await assert.rejects(f.context.call(NOTEBOOK_AGENT_TOOL.name, { ...input, root: f.other }, call), { code: 'notebook_agent_scope' });
  await assert.rejects(f.context.call(NOTEBOOK_AGENT_TOOL.name, { action: 'accept' }, call), { code: 'notebook_agent_action' });
  f.revoke(); assert.throws(() => f.context.scene(), { code: 'notebook_path_scope' });
});

test('stopping progressive ink keeps only the durable reached path and independent human work', async t => {
  const f = fixture(t), controller = new AbortController(), progress = [];
  const result = await f.context.draw({ id: 'agent-ink', type: 'ink', points: [[0,0,.5],[1000,0,.8]], color: '#111111', strokeWidth: 3 }, {
    operationId: 'fresh-stroke', durationMs: 600, signal: controller.signal,
    onProgress: event => {
      progress.push(event);
      if (progress.length === 2) {
        mutateNotebook(f.root, { protocolVersion: 1, resourceId: f.scene.resourceId, locationRevision: f.scene.locator.revision,
          operationId: 'human-independent', edits: [{ kind: 'put', id: 'human-note', expectedRevision: 0, object: { type: 'text', text: 'Keep my idea', x: 10, y: 100 } }] },
        { actor: { kind: 'human', id: 'owner' }, canWrite: () => true });
        controller.abort();
      }
    },
  });
  assert.equal(result.stopped, true); assert.equal(progress.length, 2);
  const scene = f.context.scene(), ink = scene.document.objects.find(object => object.id === 'agent-ink');
  assert.ok(ink.points.at(-1)[0] > 0 && ink.points.at(-1)[0] < 1000);
  assert.deepEqual(ink.points.at(-1), progress.at(-1).point);
  assert.equal(scene.document.objects.find(object => object.id === 'human-note').text, 'Keep my idea');
});

test('a human change to a growing stroke stops the agent without restoring an older object', async t => {
  const f = fixture(t); let changed = false;
  await assert.rejects(f.context.draw({ id: 'growing', type: 'ink', points: [[10,10,.5],[500,500,.5]] }, {
    operationId: 'race-stroke', durationMs: 300,
    onProgress: () => {
      if (changed) return; changed = true;
      const original = f.context.scene().document.objects[0];
      mutateNotebook(f.root, { protocolVersion: 1, resourceId: f.scene.resourceId, locationRevision: f.scene.locator.revision,
        operationId: 'human-stop', edits: [{ kind: 'patch', id: original.id, expectedRevision: original.revision, patch: { color: '#ff0000' } }] },
      { actor: { kind: 'human', id: 'owner' }, canWrite: () => true });
    },
  }), { code: 'notebook_object_conflict' });
  const object = f.context.scene().document.objects[0];
  assert.equal(object.color, '#ff0000'); assert.equal(object.updatedBy.kind, 'human');
});
