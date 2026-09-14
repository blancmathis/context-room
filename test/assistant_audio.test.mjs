import test from 'node:test';
import assert from 'node:assert/strict';
import { speechEndpoint, microphonePcm } from '../src/ui/assistant-audio.mjs';
import { conversationScopeAliases } from '../src/ui/assistant-drafts.mjs';

test('conversation migration aliases only the same runtime root, never another worktree', () => {
  const root = JSON.stringify(['https://original.test', 'project-a', '', '']);
  assert.deepEqual(conversationScopeAliases(root), [root, JSON.stringify(['https://original.test', 'project-a', 'project-a', ''])]);
  const other = JSON.stringify(['https://original.test', 'project-a', 'other-worktree', '']);
  assert.deepEqual(conversationScopeAliases(other), [other]); assert.deepEqual(conversationScopeAliases('opaque-original'), ['opaque-original']);
});

test('speech endpoints reject short transients, wait for a spoken phrase and stop at quiet or the bounded idle limit', () => {
  const detector = speechEndpoint(16000), frame = amplitude => new Float32Array(320).fill(amplitude);
  for (let i = 0; i < 5; i++) assert.equal(detector.push(frame(.1)), null);
  assert.equal(detector.started, false); detector.push(frame(0));
  for (let i = 0; i < 5; i++) assert.equal(detector.push(frame(.1)), null);
  assert.equal(detector.push(frame(.1)), 'speech-start');
  for (let i = 0; i < 59; i++) assert.equal(detector.push(frame(0)), null);
  assert.equal(detector.push(frame(0)), 'speech-end'); assert.equal(detector.push(frame(.1)), null);
  const quiet = speechEndpoint(16000);
  for (let i = 0; i < 749; i++) assert.equal(quiet.push(frame(.0001)), null);
  assert.equal(quiet.push(frame(.0001)), 'speech-end'); assert.equal(quiet.started, false);
});

test('journal chunks preserve continuous sample positions when converting to bounded PCM16', () => {
  const source = Float32Array.from({ length: 8820 }, (_, n) => Math.sin(n / 40));
  const whole = microphonePcm([source], 44100), chunked = microphonePcm([source.slice(0, 4096), source.slice(4096)], 44100);
  assert.equal(chunked, whole); assert.equal(Buffer.from(whole, 'base64').length, 6400);
  assert.throws(() => microphonePcm([], 16000), /no audio/);
  assert.throws(() => microphonePcm([source], 0), /format/);
});
