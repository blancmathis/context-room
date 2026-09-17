import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceDisplay, sameDisplayTarget } from '../src/ui/device-display.mjs';
const session = { serverId: 'synthetic-server', device: { id: 'synthetic-device' } };
const project = 'a'.repeat(24);
const target = { projectId: project, resourceId: 'synthetic-notebook', path: 'docs/Sketch.crnb', locationRevision: 1, sceneRevision: 2 };
function editor({ pending = false } = {}) {
  const value = { dialog: { isConnected: true, dataset: { saveState: pending ? 'pending' : 'confirmed' } },
    scopeKey: JSON.stringify(['https://room.example.test', project, '', '']), busy: () => false,
    binding: () => ({ resourceId: target.resourceId, path: target.path, locationRevision: target.locationRevision, revision: target.sceneRevision }),
    surface: { canvas: { isConnected: true }, viewportBounds: () => [0, 0, 400, 300], frameViewport: bounds => { value.framed = bounds; return true; }, schedule() {} },
    async close() { this.dialog.isConnected = false; this.surface.canvas.isConnected = false; } };
  return value;
}
function fixture(options = {}) {
  let time = 100, active = true;
  const requests = [], opened = [];
  const display = new DeviceDisplay({ session, id: 'display-session', clock: () => time, active: () => active,
    request: async (action, body) => { requests.push({ action, body }); return { protocolVersion: 1, serverId: session.serverId, deviceId: session.device.id, clientSessionId: 'display-session', serverTime: time, command: null }; },
    open: async (requested, beforePresent) => {
      const snapshot = { resourceId: target.resourceId, revision: 2, locator: { path: target.path, revision: 1 } };
      assert.equal(beforePresent(snapshot), true); opened.push(requested); return editor();
    }, ...options });
  const command = { action: 'open', operationId: 'open-operation', clientSessionId: display.id, target, expiresAt: 30_100 };
  return { display, command, requests, opened, data: () => ({ command, serverTime: time }), advance: n => { time += n; }, pause: () => { active = false; } };
}

test('shared display never confirms a network response before the common canvas renders', async () => {
  const f = fixture(); await f.display.receiveCommand(f.data());
  assert.equal(f.opened.length, 1); assert.equal(f.display.receipt, undefined);
  f.display.editor.surface.onRendered();
  assert.equal(f.display.receipt.status, 'applied'); assert.deepEqual(f.display.receipt.target, target);
  await f.display.tick(); assert.equal(f.requests[0].action, 'receipt'); assert.equal(f.requests[0].body.status, 'applied');
  assert.equal(f.display.command, null);
});

test('pending ink defers remote opening; a human action cancels it without opening a different notebook', async () => {
  const f = fixture(); f.display.attach(editor({ pending: true }));
  await f.display.receiveCommand(f.data()); assert.equal(f.display.receipt.status, 'deferred'); assert.equal(f.opened.length, 0);
  f.display.interaction(); assert.equal(f.display.receipt.status, 'cancelled');
  await f.display.tick(); assert.equal(f.requests[0].body.status, 'cancelled'); assert.equal(f.opened.length, 0);
});

test('an intervening human action invalidates a delayed opening before a dialog is presented', async () => {
  let resume, begun;
  const started = new Promise(resolve => { begun = resolve; });
  const waiting = new Promise(resolve => { resume = resolve; });
  let shown = false;
  const f = fixture({ open: async (requested, guard) => {
    begun(); await waiting;
    assert.equal(guard({ resourceId: target.resourceId, revision: 2, locator: { path: target.path, revision: 1 } }), false);
    throw new Error('Cancelled before presenting');
  } });
  const opening = f.display.receiveCommand(f.data()); await started; f.display.interaction(); resume(); await opening;
  assert.equal(shown, false); assert.equal(f.display.receipt.status, 'cancelled'); assert.equal(f.display.editor, undefined);
});

test('view following requires an exact target, an unexpired frame and actual rendering; human input stops it', () => {
  const f = fixture(), notebook = editor(); f.display.attach(notebook); f.display.setMode('follow');
  const frame = { sessionId: 'owner-view-session', sequence: 1, target, viewport: [0, 0, 100, 80], expiresAt: 5100 };
  const sent = f.display.viewBody();
  f.display.receiveView({ frame: { ...frame, target: { ...target, locationRevision: 2 } }, serverTime: 100 }, sent);
  assert.equal(notebook.framed, undefined);
  f.display.receiveView({ frame, serverTime: 100 }, sent); assert.deepEqual(notebook.framed, frame.viewport); assert.equal(f.display.viewReceipt, null);
  notebook.surface.onRendered(); assert.equal(f.display.viewReceipt.sequence, 1); assert.deepEqual(f.display.viewReceipt.viewport, [0, 0, 400, 300]);
  f.display.interaction(); assert.equal(f.display.mode, 'independent'); assert.equal(f.display.viewReceipt, null);
  f.display.receiveView({ frame, serverTime: 100 }, sent); assert.equal(f.display.frame, null);
  f.display.setMode('follow'); f.display.receiveView({ frame, serverTime: 100 }, f.display.viewBody()); f.advance(5001); notebook.surface.onRendered(); assert.equal(f.display.viewReceipt, null);
});

test('a late view response cannot move a gesture, and a revoked display cannot emit new receipts', async () => {
  let answer;
  const f = fixture({ request: () => new Promise(resolve => { answer = resolve; }) }), notebook = editor();
  f.display.attach(notebook); f.display.setMode('follow');
  const pending = f.display.tick(); f.display.interaction();
  answer({ protocolVersion: 1, serverId: session.serverId, deviceId: session.device.id, clientSessionId: f.display.id, serverTime: 100,
    view: { frame: { sessionId: 'owner-view-session', sequence: 1, target, viewport: [100, 100, 200, 200], expiresAt: 5100 } } });
  await pending; assert.equal(notebook.framed, undefined); assert.equal(f.display.mode, 'independent');
  f.display.request = async () => { throw Object.assign(new Error('Revoked'), { status: 403 }); };
  await f.display.tick(); assert.equal(f.display.closed, true); notebook.surface.onRendered(); assert.equal(f.display.viewReceipt, null);
  assert.equal(sameDisplayTarget(target, { ...target, projectId: 'b'.repeat(24) }), false);
});

test('hidden or review-only editors cannot establish a device target or confirm a command', async () => {
  const f = fixture(), notebook = editor(); f.display.attach(notebook);
  notebook.scopeKey = JSON.stringify(['https://room.example.test', project, '', '/reviews/frozen']); assert.equal(f.display.target(), null);
  f.pause(); await f.display.receiveCommand(f.data()); assert.equal(f.display.receipt.status, 'deferred'); assert.equal(f.opened.length, 0);
});
