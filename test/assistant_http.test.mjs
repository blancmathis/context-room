import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantFixture } from './fixtures/assistant.mjs';
import { listLocalProposals, readLocalProposalFile } from '../src/local_proposals.mjs';
import { writeDocReviewDecision } from '../src/context_room.mjs';

async function until(check) { for (let n = 0; n < 150; n++) { if (check()) return; await delay(20); } throw new Error('Synthetic provider did not start'); }

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
