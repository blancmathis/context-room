import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceViews } from '../src/device_views.mjs';

function fixture() {
  let time = 1000, revision = 1;
  const device = { id: 'synthetic-tablet' }, target = { projectId: 'exact-project', resourceId: 'exact-resource', path: 'docs/Sketch.crnb', locationRevision: revision };
  const views = createDeviceViews({ now: () => time, resolveTarget: (_device, projectId, resourceId) => {
    assert.equal(projectId, target.projectId); assert.equal(resourceId, target.resourceId);
    return { ...target, locationRevision: revision };
  } });
  const owner = (input, session = 'native-session') => views.exchange(device, session, 'owner', { sessionId: 'owner-session', sequence: 1, ...input }, target.projectId);
  const tablet = (input, session = 'native-session') => views.exchange(device, session, 'device', { sequence: 1, ...input });
  return { target, owner, tablet, advance: delta => { time += delta; }, move: () => revision++ };
}

test('views are independent until explicit following and only a rendered receipt confirms a frame', () => {
  const f = fixture(), share = { mode: 'share', target: f.target, viewport: [10, 20, 200, 100] };
  assert.equal(f.owner(share).receipt, null);
  assert.equal(f.tablet({ mode: 'independent' }).frame, null);
  const follow = { mode: 'follow', sequence: 2, target: f.target }, frame = f.tablet(follow).frame;
  assert.deepEqual(frame.viewport, share.viewport); assert.equal(f.owner(share).receipt, null);
  assert.throws(() => f.tablet({ ...follow, receipt: { ...frame, viewport: [100, 200, 20, 10] } }), { code: 'device_view_receipt' });
  f.tablet({ ...follow, receipt: { ...frame, viewport: [0, 0, 300, 200] } });
  assert.equal(f.owner(share).receipt.accepted, false);
  f.tablet({ mode: 'independent', sequence: 3 });
  assert.equal(f.owner(share).receipt, null);
  f.tablet({ ...follow, sequence: 4 });
  assert.equal(f.owner(share).receipt, null, 'a new follow action cannot reuse an earlier receiver receipt');
  f.advance(5001); assert.equal(f.tablet({ ...follow, sequence: 4 }).frame, null);
});

test('tablet sharing uses the same exact target and cannot create a camera feedback loop', () => {
  const f = fixture(), share = { mode: 'share', target: f.target, viewport: [100, 80, 400, 300] };
  f.tablet(share);
  assert.equal(f.owner(share).frame, null, 'two publishers never follow each other');
  const ownerFollow = { mode: 'follow', target: f.target, sequence: 2 }, frame = f.owner(ownerFollow).frame;
  assert.equal(frame.sessionId, 'native-session');
  f.owner({ ...ownerFollow, receipt: { ...frame, viewport: share.viewport } });
  assert.ok(f.tablet(share).receipt);
  assert.throws(() => f.owner({ ...ownerFollow, target: { ...f.target, projectId: 'other-project' } }), { code: 'device_view_scope' });
  f.move(); assert.throws(() => f.owner(ownerFollow), { code: 'device_view_scope' });
});

test('view sequences, leases and native sessions refuse stale or competing owner updates', () => {
  const f = fixture(), share = { mode: 'share', target: f.target, viewport: [10, 20, 200, 100], sequence: 4 };
  f.owner(share);
  assert.throws(() => f.owner({ ...share, sequence: 3 }), { code: 'device_view_replay' });
  assert.throws(() => f.owner({ ...share, viewport: [11, 20, 200, 100] }), { code: 'device_view_replay' });
  assert.throws(() => f.owner({ ...share, sessionId: 'another-owner' }), { code: 'device_view_busy' });
  f.advance(5001); f.owner({ ...share, sessionId: 'another-owner' });
  assert.throws(() => f.owner({ ...share, sequence: 5 }), { code: 'device_view_busy' });
  f.tablet({ mode: 'independent' }, 'new-native-session');
  assert.throws(() => f.owner({ ...share, nativeSessionId: 'native-session' }, 'new-native-session'), { code: 'device_view_session' });
  assert.equal(f.tablet({ mode: 'follow', target: f.target, sequence: 2 }, 'new-native-session').frame, null);
});

test('invalid camera input cannot widen the finite notebook viewport contract', () => {
  for (const viewport of [[0, 0, 0, 100], [0, 0, Infinity, 100], [0, 0, 2e6, 10], [NaN, 0, 100, 100], ['0', 0, 100, 100]]) {
    const f = fixture(); assert.throws(() => f.owner({ mode: 'share', target: f.target, viewport }), { code: 'device_view_bounds' });
    assert.equal(f.tablet({ mode: 'follow', target: f.target }).frame, null);
  }
});
