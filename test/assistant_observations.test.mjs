import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssistantObservations, OBSERVATION_LEASE_MS, OBSERVATION_IMAGE_BYTES, withSourceObservation, codexToolContent } from '../src/assistant_observations.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1kAAAAASUVORK5CYII=';
function fixture(kind = 'notebook', options = {}) {
  const conversationId = randomUUID(), clientId = randomUUID(), source = { kind, path: kind === 'notebook' ? 'docs/Original.crnb' : 'docs/Original.md',
    ...(kind === 'notebook' ? { resourceId: 'original-notebook', locationRevision: 2 } : {}) };
  let at = 10000, permitted = true;
  const current = { source, currentRevision: 4, currentHash: 'a'.repeat(64) };
  const observation = new AssistantObservations({ now: () => at, ...options, resolve(project, id) {
    if (!permitted || project !== 'original' || id !== conversationId) throw Object.assign(new Error('Synthetic original source refused'), { code: 'source_scope' });
    return current;
  } });
  const identity = { conversationId, clientId };
  const begin = () => ({ ...identity, epoch: observation.control('original', { ...identity, action: 'start' }).epoch });
  const frame = kind === 'notebook' ? { resourceId: source.resourceId, locationRevision: 2, revision: 4, viewport: [0, 0, 200, 100], selection: ['live-stroke'], image: png }
    : { baseHash: current.currentHash, text: 'An unaccepted human draft.', offset: 0, totalLength: 'An unaccepted human draft.'.length, selection: { start: 0, end: 2 } };
  return { observation, conversationId, clientId, current, begin, frame, advance(ms) { at += ms; }, revoke() { permitted = false; } };
}

test('live original-source previews require explicit activation, expire and never become accepted data', () => {
  const f = fixture(), o = f.observation;
  assert.equal(o.read('original', f.conversationId).state, 'off');
  assert.throws(() => o.publish('original', { conversationId: f.conversationId, clientId: f.clientId, epoch: randomUUID(), sequence: 1, frame: f.frame }), { code: 'assistant_observation_stale' });
  const owned = f.begin(); assert.equal(o.read('original', f.conversationId).state, 'paused');
  o.publish('original', { ...owned, sequence: 1, frame: f.frame });
  const seen = o.read('original', f.conversationId);
  assert.equal(seen.state, 'live'); assert.equal(seen.path, 'docs/Original.crnb'); assert.equal(seen.accepted, false); assert.equal(seen.imageUrl, png);
  assert.equal(seen.revision, 4); assert.equal(seen.temporary, true); assert.equal(o.status('original', f.conversationId).lastObservedAt, 10000);
  f.frame.viewport[0] = 900; assert.equal(o.read('original', f.conversationId).viewport[0], 0);
  f.advance(OBSERVATION_LEASE_MS); assert.equal(o.read('original', f.conversationId).state, 'off'); assert.equal(o.streams.size, 0);
  assert.throws(() => o.publish('original', { ...owned, sequence: 2, frame: f.frame }), { code: 'assistant_observation_stale' });
});

test('sharing takeover, pause and queued frames require the exact active epoch and ordered sequence', () => {
  const f = fixture(), o = f.observation, old = f.begin(), nextClient = randomUUID();
  o.publish('original', { ...old, sequence: 1, frame: f.frame });
  assert.throws(() => o.control('original', { ...old, clientId: nextClient, action: 'start' }), { code: 'assistant_observation_owned' });
  const next = o.control('original', { ...old, clientId: nextClient, action: 'start', takeover: true });
  const owned = { ...old, clientId: nextClient, epoch: next.epoch };
  for (const action of ['stop', 'pause']) assert.throws(() => o.control('original', { ...old, action, sequence: 5 }), { code: 'assistant_observation_stale' });
  assert.throws(() => o.publish('original', { ...old, sequence: 9, frame: f.frame }), { code: 'assistant_observation_stale' });
  assert.equal(o.read('original', f.conversationId).state, 'paused');
  o.publish('original', { ...owned, sequence: 1, frame: f.frame });
  o.control('original', { ...owned, action: 'pause', sequence: 3 });
  assert.throws(() => o.publish('original', { ...owned, sequence: 2, frame: f.frame }), { code: 'assistant_observation_sequence' });
  assert.equal(o.read('original', f.conversationId).state, 'paused');
  o.publish('original', { ...owned, sequence: 4, frame: f.frame });
  assert.throws(() => o.control('original', { ...owned, action: 'pause', sequence: 3 }), { code: 'assistant_observation_sequence' });
  o.control('original', { ...owned, action: 'stop' }); assert.equal(o.read('original', f.conversationId).state, 'off');
});

test('foreign projects, moved notebooks, future revisions, revoked access and oversized images cannot supply a preview', () => {
  const f = fixture(), o = f.observation, owned = f.begin();
  assert.throws(() => o.publish('other', { ...owned, sequence: 1, frame: f.frame }), { code: 'source_scope' });
  for (const change of [{ resourceId: 'other' }, { locationRevision: 3 }, { revision: 5 }])
    assert.throws(() => o.publish('original', { ...owned, sequence: 1, frame: { ...f.frame, ...change } }), { code: 'assistant_observation_source' });
  const oversized = Buffer.alloc(OBSERVATION_IMAGE_BYTES + 1).toString('base64');
  assert.throws(() => o.publish('original', { ...owned, sequence: 1, frame: { ...f.frame, image: 'data:image/png;base64,' + oversized } }), { code: 'assistant_observation_image' });
  const pixels = Buffer.from(png.split(',')[1], 'base64'); pixels.writeUInt32BE(1025, 16);
  assert.throws(() => o.publish('original', { ...owned, sequence: 1, frame: { ...f.frame, image: 'data:image/png;base64,' + pixels.toString('base64') } }), { code: 'assistant_observation_image' });
  assert.equal(o.read('original', f.conversationId).state, 'paused');
  o.publish('original', { ...owned, sequence: 1, frame: f.frame }); f.revoke();
  assert.throws(() => o.read('original', f.conversationId), { code: 'source_scope' });
});

test('document observations retain a bounded draft excerpt and stop exposing it after the saved source changes', () => {
  const f = fixture('document'), o = f.observation, owned = f.begin();
  o.publish('original', { ...owned, sequence: 1, frame: f.frame });
  assert.equal(o.read('original', f.conversationId).text, f.frame.text);
  f.current.currentHash = 'b'.repeat(64);
  const changed = o.read('original', f.conversationId); assert.equal(changed.state, 'paused'); assert.equal(changed.text, undefined);
  assert.throws(() => o.publish('original', { ...owned, sequence: 2, frame: f.frame }), { code: 'assistant_observation_source' });
  assert.equal(f.frame.text, 'An unaccepted human draft.');
});

test('only explicitly attached original-source images become Codex image content', () => {
  const f = fixture(), owned = f.begin(); f.observation.publish('original', { ...owned, sequence: 1, frame: f.frame });
  const result = withSourceObservation({ revision: 4, accepted: false }, f.observation.read('original', f.conversationId));
  assert.equal(JSON.stringify(result).includes(png), false, 'Base64 must not enter the text receipt');
  const content = codexToolContent(result); assert.equal(content.length, 2); assert.deepEqual(content[1], { type: 'inputImage', imageUrl: png });
  assert.equal(codexToolContent(JSON.parse(JSON.stringify(result))).length, 1, 'Untrusted JSON cannot forge the internal image marker');
  assert.equal(codexToolContent({ imageUrl: png, observation: { imageUrl: png } }).length, 1);
});

test('the number of live preview streams stays bounded and expiry frees capacity', () => {
  let at = 0; const o = new AssistantObservations({ now: () => at, maxStreams: 1,
    resolve: () => ({ source: { kind: 'document', path: 'docs/Original.md' }, currentHash: 'a'.repeat(64) }) });
  o.control('original', { conversationId: randomUUID(), clientId: randomUUID(), action: 'start' });
  const other = { conversationId: randomUUID(), clientId: randomUUID(), action: 'start' };
  assert.throws(() => o.control('original', other), { code: 'assistant_observation_busy' });
  at += OBSERVATION_LEASE_MS; o.control('original', other); assert.equal(o.streams.size, 1);
  o.close(); assert.equal(o.streams.size, 0);
});
