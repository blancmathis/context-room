import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantFixture } from './fixtures/assistant.mjs';
import { listLocalProposals, readLocalProposalFile } from '../src/local_proposals.mjs';
import { writeDocReviewDecision } from '../src/context_room.mjs';
import { codexToolContent } from '../src/assistant_observations.mjs';

async function until(check) { for (let n = 0; n < 150; n++) { if (check()) return; await delay(20); } throw new Error('Synthetic provider did not start'); }

test('live previews require the existing exact-project owner and origin guards without starting an agent', async t => {
  const f = await assistantFixture(); t.after(() => f.close());
  const created = await f.post('/api/assistant/conversations', { source: { kind: 'document', path: 'docs/Original.md' } });
  const body = { conversationId: created.body.id, clientId: randomUUID(), action: 'start' };
  for (const route of ['/api/assistant/observation/controller', '/api/assistant/observation/frame']) {
    assert.equal((await f.post(route, body, { 'x-context-room-owner-nonce': '' })).status, 403);
    assert.equal((await f.post(route, body, { origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await f.post(route, body, { 'x-context-room-project': 'different-project' })).status, 409);
  }
  assert.equal((await f.post('/api/assistant/observation/controller', body)).status, 200);
  const response = await fetch(f.url + '/api/assistant/conversations/' + created.body.id + '/observation');
  const status = await response.json(); assert.equal(status.active, true); assert.equal(status.paused, true);
  assert.equal(JSON.stringify(status).includes('image'), false); assert.equal(f.connections(), 0);
});

test('assistant HTTP creation requires owner, original project and trusted browser; no provider starts on reads', async t => {
  const f = await assistantFixture(); t.after(() => f.close());
  const request = { requestId: randomUUID(), source: { kind: 'document', path: 'docs/Original.md' } };
  assert.equal((await f.post('/api/assistant/conversations', request, { 'x-context-room-owner-nonce': '' })).status, 403);
  assert.equal((await f.post('/api/assistant/conversations', request, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.post('/api/assistant/conversations', request, { 'x-context-room-project': 'different-project' })).status, 409);
  const created = await f.post('/api/assistant/conversations', request); assert.equal(created.status, 201);
  const id = created.body.id, current = await fetch(f.url + '/api/assistant/conversations/' + id); assert.equal(current.status, 200); assert.equal((await current.json()).operation, null);
  assert.equal((await fetch(f.url + '/api/assistant/capabilities')).status, 200); assert.equal(f.connections(), 0);
  assert.equal((await f.post('/api/assistant/conversations', { ...request, requestId: randomUUID(), source: { kind: 'document', path: '../Other.md' } })).status, 403);
  assert.equal((await f.post('/api/assistant/conversations/' + id + '/send', { requestId: randomUUID(), text: 'Explicit synthetic message' })).status, 202);
  await until(() => f.turns.length === 1); assert.ok(f.turns[0].text.includes('Human original content.')); f.finish();
});

test('the scoped document tool creates an existing-engine proposal without changing either ordinary file', async t => {
  const f = await assistantFixture(); t.after(() => f.close());
  // Human acceptance is synthetic setup, isolated from all personal projects and ledgers.
  writeDocReviewDecision(f.root, 'docs/Original.md', { status: 'verified' }); writeDocReviewDecision(f.root, 'docs/Other.md', { status: 'verified' });
  const original = fs.readFileSync(path.join(f.root, 'docs/Original.md')), other = fs.readFileSync(path.join(f.root, 'docs/Other.md'));
  const created = await f.post('/api/assistant/conversations', { source: { kind: 'document', path: 'docs/Original.md' } }); assert.equal(created.status, 201);
  await f.post('/api/assistant/conversations/' + created.body.id + '/send', { requestId: randomUUID(), text: 'Propose a synthetic improvement' });
  await until(() => f.turns.length === 1); const turn = f.turns[0], options = { callId: 'read', turnId: turn.turnId, signal: new AbortController().signal };
  const current = await turn.tool('context_room_document', { action: 'read' }, options);
  const result = await turn.tool('context_room_document', { action: 'propose', expectedHash: current.hash, title: 'Synthetic improvement', content: '# Proposed document\n\nReview this change.\n' }, { ...options, callId: 'propose' });
  assert.equal(result.accepted, false); assert.equal(result.status, 'submitted');
  const proposals = listLocalProposals(f.root); assert.equal(proposals.length, 1); assert.deepEqual(proposals[0].changes.map(change => change.path), ['docs/Original.md']);
  assert.match(readLocalProposalFile(f.root, result.proposalId, 'docs/Original.md').afterBytes.toString('utf8'), /Review this change/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'docs/Original.md')), original); assert.deepEqual(fs.readFileSync(path.join(f.root, 'docs/Other.md')), other);
  f.finish('Synthetic proposal is ready for human review.');
});

test('a conversation proposal keeps the accepted mode and refuses unreviewed edits', async t => {
  const f = await assistantFixture(); t.after(() => f.close());
  const file = path.join(f.root, 'docs/Original.md');
  fs.chmodSync(file, 0o755);
  writeDocReviewDecision(f.root, 'docs/Original.md', { status: 'verified' });
  const created = await f.post('/api/assistant/conversations', { source: { kind: 'document', path: 'docs/Original.md' } }); assert.equal(created.status, 201);
  await f.post('/api/assistant/conversations/' + created.body.id + '/send', { requestId: randomUUID(), text: 'Propose twice' });
  await until(() => f.turns.length === 1); const turn = f.turns[0], options = { callId: 'read', turnId: turn.turnId, signal: new AbortController().signal };
  const accepted = await turn.tool('context_room_document', { action: 'read' }, options);
  const result = await turn.tool('context_room_document', { action: 'propose', expectedHash: accepted.hash, content: '# Kept mode\n' }, { ...options, callId: 'propose-mode' });
  const change = readLocalProposalFile(f.root, result.proposalId, 'docs/Original.md');
  assert.equal(change.after.mode & 0o777, 0o755);

  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\nUnreviewed human edit.\n');
  const unreviewed = await turn.tool('context_room_document', { action: 'read' }, { ...options, callId: 'read-2' });
  await assert.rejects(turn.tool('context_room_document', { action: 'propose', expectedHash: unreviewed.hash, content: '# Laundered\n' }, { ...options, callId: 'propose-unreviewed' }), (error) => /not reviewed/.test(error.message));
  assert.equal(listLocalProposals(f.root).length, 1);
  f.finish('done');
});

test('an annotation conversation replaces only its exact passage and refuses forged or stale anchors', async t => {
  const f = await assistantFixture(); t.after(() => f.close());
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1kAAAAASUVORK5CYII=';
  const file = path.join(f.root, 'docs/Original.md'), text = '# Été\n\nSame paragraph.\n\nSame paragraph.\n\nLast — line.\n';
  fs.writeFileSync(file, text); fs.chmodSync(file, 0o755);
  writeDocReviewDecision(f.root, 'docs/Original.md', { status: 'verified' });
  const start = text.lastIndexOf('Same paragraph.'), selection = { start, end: start + 'Same paragraph.'.length, text: 'Same paragraph.' };
  const create = source => f.post('/api/assistant/conversations', { source: { kind: 'document', path: 'docs/Original.md', ...source } });
  assert.equal((await create({ selection: { ...selection, start: start - 1, end: start - 1 + 15 }, annotation: { image: png } })).status, 409, 'A forged anchor is refused');
  assert.equal((await create({ selection, annotation: { image: { sha256: 'a'.repeat(64) } } })).status, 400, 'Only the runtime stores a snapshot');
  const created = await create({ selection, annotation: { image: png, section: 'Été' } }); assert.equal(created.status, 201);
  assert.equal(created.body.source.annotation.byteStart, Buffer.byteLength(text.slice(0, start)));
  await f.post('/api/assistant/conversations/' + created.body.id + '/send', { requestId: randomUUID(), text: 'Simplify this' });
  await until(() => f.turns.length === 1); const turn = f.turns[0], options = { callId: 'see', turnId: turn.turnId, signal: new AbortController().signal };
  const seen = await turn.tool('context_room_document', { action: 'annotation' }, options);
  assert.equal(seen.valid, true); assert.equal(seen.text, 'Same paragraph.'); assert.deepEqual(codexToolContent(seen)[1], { type: 'inputImage', imageUrl: png });
  await assert.rejects(turn.tool('context_room_document', { action: 'replace_annotation', annotationId: 'annotation-other', replacement: 'X' }, { ...options, callId: 'wrong' }), /id of this conversation/);
  const result = await turn.tool('context_room_document', { action: 'replace_annotation', annotationId: seen.annotationId, replacement: 'One clear line.' }, { ...options, callId: 'replace' });
  const change = readLocalProposalFile(f.root, result.proposalId, 'docs/Original.md');
  assert.deepEqual(change.afterBytes, Buffer.from(text.slice(0, start) + 'One clear line.' + text.slice(selection.end)));
  assert.equal(change.after.mode & 0o777, 0o755);
  fs.writeFileSync(file, text.replace('Last', 'Final')); writeDocReviewDecision(f.root, 'docs/Original.md', { status: 'verified' });
  await assert.rejects(turn.tool('context_room_document', { action: 'replace_annotation', annotationId: seen.annotationId, replacement: 'Y' }, { ...options, callId: 'stale' }), /changed since this annotation/);
  assert.equal(listLocalProposals(f.root).length, 1);
  f.finish('done');
});
