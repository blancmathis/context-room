import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantSourceResolver } from '../src/assistant_sources.mjs';
import { AssistantRuntime } from '../src/assistant_runtime.mjs';
import { openNotebook, mutateNotebook, readNotebook } from '../src/notebooks.mjs';
import { notebookHash } from '../src/notebook_io.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-assistant-runtime-'))), root = path.join(base, 'project'), privateRoot = path.join(base, 'private');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); fs.mkdirSync(privateRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'docs/Original.md'), 'Original document.\nSecond paragraph.\n');
  let allowed = true; const proposals = [];
  const resolveSource = createAssistantSourceResolver({ canRead: (project, rel) => allowed && project === root && rel.startsWith('docs/'), canWrite: () => allowed,
    proposeDocument: async (project, input) => { proposals.push({ project, input }); return { proposalId: 'synthetic-proposal', accepted: false }; } });
  let clock = Date.now(), starts = 0;
  const audio = { modelPath: path.join(root, 'docs/Original.md'), async transcribe(pcm, { signal }) { await delay(30); signal.throwIfAborted(); return { text: 'Synthetic transcript', submitted: false }; },
    async synthesize(text, { signal }) { await delay(30); signal.throwIfAborted(); return { text, played: false, pcm: 'AAA=', sampleRate: 24000 }; } };
  const runtime = new AssistantRuntime({ root: privateRoot, resolveSource, audio, now: () => clock, providerFactory: async () => { starts++; throw new Error('No live provider in this test'); } });
  t.after(async () => { await runtime.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { root, privateRoot, runtime, resolveSource, proposals, starts: () => starts, revoke: () => { allowed = false; }, advance: ms => { clock += ms; },
    conversation: () => runtime.sessions.create(root, { source: { kind: 'document', path: 'docs/Original.md' } }) };
}
async function settled(f, body, id) { for (let n = 0; n < 100; n++) { const job = f.runtime.job(f.root, id, body); if (job.status !== 'running') return job; await delay(10); } throw new Error('Audio job did not finish'); }

test('original document selection is retained, current hashes are required and path injection is rejected', async t => {
  const f = fixture(t), original = f.resolveSource(f.root, { kind: 'document', path: 'docs/Original.md', selection: { start: 0, end: 8, text: 'Original' } }, { creating: true, sessionId: randomUUID() });
  assert.equal(original.source.original.excerpt, 'Original');
  const file = await original.call('context_room_document', { action: 'read' }); assert.equal(file.hash, notebookHash(fs.readFileSync(path.join(f.root, 'docs/Original.md'))));
  await assert.rejects(original.call('context_room_document', { action: 'propose', path: 'docs/Other.md', content: 'wrong' }), { code: 'assistant_tool_scope' });
  fs.writeFileSync(path.join(f.root, 'docs/Original.md'), 'Human change');
  assert.equal(original.context().source.original.excerpt, 'Original');
  await assert.rejects(original.call('context_room_document', { action: 'propose', expectedHash: file.hash, content: 'stale replacement' }, { turnId: 'one', callId: 'one' }), { code: 'assistant_document_conflict' });
  assert.equal(f.proposals.length, 0);
  const current = await original.call('context_room_document', { action: 'read' });
  const proposed = await original.call('context_room_document', { action: 'propose', expectedHash: current.hash, content: 'Proposed improvement' }, { turnId: 'one', callId: 'two' });
  assert.equal(proposed.accepted, false); assert.equal(f.proposals[0].input.path, 'docs/Original.md');
  assert.equal(fs.readFileSync(path.join(f.root, 'docs/Original.md'), 'utf8'), 'Human change');
});

test('a deleted notebook selection keeps its original reference and permits reading the current scene', async t => {
  const f = fixture(t), initial = openNotebook(f.root, { path: 'docs/Scene.crnb', id: 'original', canWrite: () => true });
  const edit = edits => mutateNotebook(f.root, { protocolVersion: 1, resourceId: initial.resourceId, locationRevision: initial.locator.revision, operationId: randomUUID(), edits }, { canWrite: () => true, actor: { kind: 'human', id: 'owner' } });
  edit([{ kind: 'put', id: 'human-label', expectedRevision: 0, object: { type: 'text', text: 'Keep this source', x: 0, y: 0 } }]);
  const scene = readNotebook(f.root, initial.resourceId);
  const conversation = f.runtime.sessions.create(f.root, { source: { kind: 'notebook', path: scene.locator.path, resourceId: scene.resourceId, revision: scene.revision, locationRevision: scene.locator.revision, selection: ['human-label'] } });
  edit([{ kind: 'delete', id: 'human-label', expectedRevision: 1 }]);
  const saved = f.runtime.sessions.get(f.root, conversation.id); assert.equal(saved.source.original.selection[0].text, 'Keep this source');
  const resolved = f.resolveSource(f.root, saved.source, { sessionId: saved.id });
  assert.deepEqual(resolved.context().missingSelectedObjects, ['human-label']);
  const current = await resolved.call('context_room_notebook', { action: 'scene' }, { turnId: 'one', callId: 'read' });
  assert.equal(current.document.objects.length, 0); assert.equal(current.originalRevision, scene.revision);
});

test('audio ownership needs an explicit fresh takeover and stale epochs cannot read or prepare audio', async t => {
  const f = fixture(t), a = f.conversation(), b = f.conversation(), clientA = randomUUID(), clientB = randomUUID();
  const first = f.runtime.lease(f.root, { conversationId: a.id, clientId: clientA });
  assert.throws(() => f.runtime.lease(f.root, { conversationId: b.id, clientId: clientB }), { code: 'assistant_audio_owned' });
  assert.throws(() => f.runtime.lease(f.root, { conversationId: b.id, clientId: clientB, takeover: true, epoch: randomUUID() }), { code: 'assistant_audio_owned' });
  const second = f.runtime.lease(f.root, { conversationId: b.id, clientId: clientB, takeover: true, epoch: first.epoch });
  assert.notEqual(second.epoch, first.epoch);
  const old = { conversationId: a.id, clientId: clientA, epoch: first.epoch, requestId: randomUUID(), pcm: 'AAMAAg==' };
  assert.throws(() => f.runtime.transcribe(f.root, old), { code: 'assistant_audio_stale' });
  f.advance(30_001); assert.equal(f.runtime.capabilities(f.root).audio.controller, null);
  assert.throws(() => f.runtime.lease(f.root, { ...second, action: 'renew' }), { code: 'assistant_audio_stale' });
  assert.equal(f.starts(), 0);
});

test('dictation retries are bounded and never send a turn; speech uses the exact saved answer and separate played receipt', async t => {
  const f = fixture(t), conversation = f.conversation(), clientId = randomUUID();
  const lease = f.runtime.lease(f.root, { conversationId: conversation.id, clientId }), body = { conversationId: conversation.id, clientId, epoch: lease.epoch };
  const request = { ...body, requestId: randomUUID(), pcm: Buffer.from([0, 2, 0, 2]).toString('base64') };
  const first = f.runtime.transcribe(f.root, request), again = f.runtime.transcribe(f.root, request); assert.equal(first.id, again.id);
  assert.throws(() => f.runtime.transcribe(f.root, { ...request, pcm: 'AQIBAg==' }), { code: 'assistant_audio_replay' });
  const transcript = await settled(f, body, first.id); assert.equal(transcript.result.submitted, false); assert.equal(f.runtime.sessions.get(f.root, conversation.id).messages.length, 0);
  f.runtime.sessions.update(conversation.id, value => value.messages.push({ id: 'reply', role: 'assistant', text: 'Exact original answer.', complete: true }));
  assert.throws(() => f.runtime.speak(f.root, { ...body, requestId: randomUUID(), messageId: 'foreign', start: 0, end: 4 }), { code: 'assistant_speech_passage' });
  const speech = f.runtime.speak(f.root, { ...body, requestId: randomUUID(), messageId: 'reply', start: 0, end: 5 });
  const prepared = await settled(f, body, speech.id); assert.equal(prepared.result.text, 'Exact'); assert.equal(prepared.result.played, false);
  assert.equal(f.runtime.receipt(f.root, { ...body, requestId: speech.id, played: true }).played, true); assert.equal(f.starts(), 0);
  f.revoke(); assert.throws(() => f.runtime.job(f.root, speech.id, body), { code: 'assistant_source_scope' });
});

test('long speech releases played PCM while retaining exact request receipts in the active epoch', async t => {
  const f = fixture(t), conversation = f.conversation(), clientId = randomUUID();
  const lease = f.runtime.lease(f.root, { conversationId: conversation.id, clientId }), body = { conversationId: conversation.id, clientId, epoch: lease.epoch };
  const answer = 'Long synthetic answer. '.repeat(650);
  f.runtime.sessions.update(conversation.id, value => value.messages.push({ id: 'long-reply', role: 'assistant', text: answer, complete: true }));
  let generated = 0; const synthesize = f.runtime.audio.synthesize;
  f.runtime.audio.synthesize = async (...args) => { generated++; return { ...await synthesize(...args), data: 'Synthetic waveform bytes' }; };
  const requests = [];
  for (let start = 0; start < answer.length; start += 400) {
    const request = { ...body, requestId: randomUUID(), messageId: 'long-reply', start, end: Math.min(start + 400, answer.length) }; requests.push(request);
    const job = f.runtime.speak(f.root, request); assert.equal((await settled(f, body, job.id)).result.played, false);
    assert.equal(f.runtime.receipt(f.root, { ...body, requestId: job.id, played: true }).played, true);
    const completed = f.runtime.job(f.root, job.id, body); assert.equal(completed.result.played, true);
    assert.equal(completed.result.pcm, undefined); assert.equal(completed.result.data, undefined);
  }
  assert.ok(requests.length > 24);
  assert.equal(f.runtime.speak(f.root, requests[0]).result.played, true);
  assert.equal(f.runtime.receipt(f.root, { ...body, requestId: requests[0].requestId, played: true }).played, true);
  assert.equal(generated, requests.length, 'An acknowledged request must not synthesize again');
  assert.throws(() => f.runtime.speak(f.root, { ...requests[0], end: 10 }), { code: 'assistant_audio_replay' });
  f.runtime.lease(f.root, { ...body, action: 'release' });
  const next = f.runtime.lease(f.root, { conversationId: conversation.id, clientId });
  assert.throws(() => f.runtime.speak(f.root, requests[0]), { code: 'assistant_audio_stale' });
  const fresh = { ...body, epoch: next.epoch, requestId: randomUUID(), pcm: 'AAMAAg==' };
  f.runtime.transcribe(f.root, fresh); assert.equal(f.runtime.jobs.size, 1, 'A new epoch drops inaccessible old receipts');
  await settled(f, fresh, fresh.requestId); assert.equal(f.starts(), 0);
});

test('unconsumed audio stays bounded and expiry cannot silently rerun the same request', async t => {
  const f = fixture(t), conversation = f.conversation(), clientId = randomUUID();
  const lease = f.runtime.lease(f.root, { conversationId: conversation.id, clientId }), body = { conversationId: conversation.id, clientId, epoch: lease.epoch };
  let processed = 0; const transcribe = f.runtime.audio.transcribe;
  f.runtime.audio.transcribe = async (...args) => { processed++; return transcribe(...args); };
  let first;
  for (let index = 0; index < 24; index++) {
    const request = { ...body, requestId: randomUUID(), pcm: 'AAMAAg==' }; first ||= request;
    const job = f.runtime.transcribe(f.root, request); await settled(f, body, job.id);
  }
  assert.throws(() => f.runtime.transcribe(f.root, { ...first, requestId: randomUUID() }), { code: 'assistant_audio_busy' });
  for (let index = 0; index < 21; index++) { f.advance(29_000); f.runtime.lease(f.root, { ...body, action: 'renew' }); }
  const expired = f.runtime.transcribe(f.root, first); assert.equal(expired.status, 'failed'); assert.equal(expired.result, null);
  assert.equal(processed, 24, 'An expired request retains its failure identity in the current epoch');
  const retry = { ...first, requestId: randomUUID() }; f.runtime.transcribe(f.root, retry); await settled(f, body, retry.requestId);
  assert.equal(processed, 25);
});
