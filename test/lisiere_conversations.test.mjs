import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { legacyConversationSnapshot } from './fixtures/lisiere-conversations.mjs';
import { createAssistantSourceResolver } from '../src/assistant_sources.mjs';
import { AssistantSessions } from '../src/assistant_sessions.mjs';
import { migrateLisiereConversationHistory } from '../src/lisiere_conversations.mjs';
import { notebookHash } from '../src/notebook_io.mjs';

async function fixture(t, settings = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-conversation-recovery-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), storageRoot = path.join(base, 'private-assistant'); fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const original = path.join(root, 'docs/Original.md'); fs.writeFileSync(original, '# Exact linked document\n');
  const legacy = await legacyConversationSnapshot(base, settings); let permitted = true;
  const resolveSource = createAssistantSourceResolver({ canRead: (project, rel) => permitted && project === root && rel === 'docs/Original.md', canWrite: () => false });
  const options = { snapshot: legacy.snapshot, selector: legacy.selector, path: 'docs/Original.md' };
  const authority = { storageRoot, resolveSource, sourceForPath: (_, rel) => ({ kind: 'document', path: rel }) };
  const plan = () => migrateLisiereConversationHistory(root, options, authority);
  const apply = revision => migrateLisiereConversationHistory(root, { ...options, apply: true, expectedRevision: revision }, authority);
  const services = []; t.after(async () => { for (const service of services) await service.close(); });
  return { base, root, original, storageRoot, legacy, options, authority, plan, apply, revoke: () => { permitted = false; },
    service(providerFactory = () => { throw new Error('Read-only recovery must not start a provider'); }) { const service = new AssistantSessions({ root: storageRoot, resolveSource, providerFactory }); services.push(service); return service; } };
}

test('private conversation recovery retains exact source cells, original task, partial answers and unknown events without dispatch', async t => {
  const f = await fixture(t, { desktop: true, extraMessages: 65, longText: 'Long original passage. '.repeat(1300) });
  const before = fs.readFileSync(f.original), database = fs.readFileSync(path.join(f.legacy.source, 'workspace.sqlite'));
  const plan = f.plan(); assert.equal(fs.existsSync(f.storageRoot), false); assert.equal(plan.accepted, false);
  const result = f.apply(plan.revision), service = f.service(), state = service.get(f.root, result.conversationId);
  assert.equal(state.threadId, null); assert.equal(state.legacy.originalThreadId, 'retained-task-original'); assert.equal(state.legacy.transport, 'desktop');
  assert.deepEqual(state.messages, []); assert.equal(state.operation, null); assert.equal(fs.statSync(f.storageRoot).mode & 0o077, 0);
  const first = service.legacyHistory(f.root, state.id), messages = [...first.messages]; let offset = first.pagination.nextOffset;
  while (offset !== null) { const page = service.legacyHistory(f.root, state.id, { offset }); messages.push(...page.messages); offset = page.pagination.nextOffset; }
  assert.equal(messages.length, state.legacy.messageCount); assert.equal(new Set(messages.map(message => message.index)).size, messages.length);
  assert.equal(messages[0].originalSeq, '9007199254740995'); assert.equal(messages[0].text, 'Original human question 🖊️');
  assert.equal(messages.filter(message => message.role === 'assistant' && message.completion === 'item-completed').length, 1);
  const complete = messages.find(message => message.completion === 'item-completed'); assert.notEqual(complete.nextTextOffset, null);
  let text = complete.text, next = complete.nextTextOffset;
  while (next !== null) { const page = service.legacyHistory(f.root, state.id, { message: complete.index, textOffset: next }); text += page.messages[0].text; next = page.messages[0].nextTextOffset; }
  const archive = service.legacyArchive(f.root, state.id), original = JSON.parse(archive);
  assert.equal(text, original.messages[complete.index].text); assert.ok(messages.some(message => message.completion === 'partial'));
  assert.ok(messages.some(message => message.completion === 'delivery-unconfirmed')); assert.ok(original.original.events.some(event => event.kind === 'unknown/future-event'));
  assert.deepEqual(original.original.events[0].seq, { integer: '9007199254740995' }); assert.equal(original.original.events.some(event => event.conversation === 'other'), false);
  assert.equal(notebookHash(archive), service.read(state.id).legacy.hash);
  assert.equal(fs.readFileSync(f.original).equals(before), true); assert.equal(fs.readFileSync(path.join(f.legacy.source, 'workspace.sqlite')).equals(database), true);
  assert.equal(fs.existsSync(path.join(f.root, '.context-room')), false);
  f.revoke(); assert.throws(() => service.legacyHistory(f.root, state.id), { code: 'assistant_source_scope' });
});

test('retained recovery requires the exact source preview and never replaces a later human continuation', async t => {
  const f = await fixture(t), plan = f.plan(); fs.writeFileSync(f.original, 'Changed after preview');
  assert.throws(() => f.apply(plan.revision), /changed after preview/); assert.equal(fs.existsSync(f.storageRoot), false);
  fs.writeFileSync(f.original, '# Exact linked document\n'); const result = f.apply(plan.revision), service = f.service();
  service.update(result.conversationId, state => { state.messages.push({ role: 'user', text: 'Later human continuation' }); state.threadId = 'new-context-room-task'; });
  fs.writeFileSync(f.original, 'Later document edit'); const repeated = f.apply(plan.revision);
  assert.equal(repeated.replayed, true); assert.equal(repeated.conversationId, result.conversationId); assert.equal(repeated.threadId, 'new-context-room-task');
  assert.equal(service.read(result.conversationId).messages[0].text, 'Later human continuation');
  f.options.path = 'docs/Elsewhere.md'; assert.throws(f.plan, { code: 'assistant_source_scope' });
  const outside = path.join(f.base, 'another-project'); fs.mkdirSync(outside); assert.throws(() => service.legacyHistory(outside, result.conversationId), { code: 'assistant_scope' });
});

test('binary historical context retains exact int64 and UTF-16 values in its readable projection and original export', async t => {
  const f = await fixture(t, { binaryContext: true }), imported = f.apply(f.plan().revision), service = f.service();
  const message = service.legacyHistory(f.root, imported.conversationId).messages[0];
  assert.equal(message.text, 'Original human question 🖊️'); assert.deepEqual(JSON.parse(message.context).revision, { integer: '9007199254740997' });
  const archive = JSON.parse(service.legacyArchive(f.root, imported.conversationId));
  const original = execFileSync('python3', ['-B', '-c', 'import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: sys.stdout.buffer.write(db.execute("SELECT data FROM messages WHERE seq=9007199254740995").fetchone()[0])', path.join(f.legacy.source, 'workspace.sqlite')]);
  assert.equal(Buffer.from(archive.original.events[0].data.base64, 'base64').equals(original), true);
});

test('interrupted archive, binding and provenance publication resume without losing later edits', async t => {
  for (const stage of ['legacy-history/', 'conversations/', 'legacy-history-sources/']) {
    const f = await fixture(t), plan = f.plan(), link = fs.linkSync; let interrupted = false;
    fs.linkSync = (from, to, ...rest) => { link(from, to, ...rest); if (!interrupted && String(to).includes('/' + stage) && String(to).endsWith('.json')) { interrupted = true; throw new Error('Lost historical publication acknowledgment'); } };
    try { assert.throws(() => f.apply(plan.revision), /Lost historical publication acknowledgment/); } finally { fs.linkSync = link; }
    assert.equal(interrupted, true); const binding = path.join(f.storageRoot, 'conversations', plan.conversationId + '.json');
    if (fs.existsSync(binding)) f.service().update(plan.conversationId, state => { state.messages.push({ role: 'user', text: 'Later retained human text' }); });
    const existed = fs.existsSync(binding), applied = f.apply(plan.revision), service = f.service();
    assert.equal(applied.conversationId, plan.conversationId); assert.equal(service.list(f.root).length, 1);
    assert.equal(service.get(f.root, applied.conversationId).messages.length, existed ? 1 : 0); service.legacyArchive(f.root, applied.conversationId);
  }
});

test('only a new explicit send starts a scoped task and can read historical data without resuming or replaying the original', async t => {
  const f = await fixture(t, { desktop: true }), imported = f.apply(f.plan().revision), starts = [], turns = [], resumes = []; let connections = 0;
  const service = f.service(async () => { connections++; return {
    async startThread(input) { starts.push(input); return { threadId: 'new-scoped-task' }; },
    async resumeOwnedThread(input) { resumes.push(input); return { threadId: input.threadId }; },
    async startTurn(input) { turns.push(input); input.onEvent({ type: 'started', turnId: 'new-turn' }); return { turnId: 'new-turn' }; }, async close() {},
  }; });
  service.get(f.root, imported.conversationId); service.legacyHistory(f.root, imported.conversationId); assert.equal(connections, 0);
  service.send(f.root, imported.conversationId, { requestId: randomUUID(), text: 'My new explicit scoped question.' });
  for (let i = 0; i < 100 && !turns.length; i++) await delay(10); assert.equal(turns.length, 1);
  assert.equal(starts.length, 1); assert.equal(resumes.length, 0); assert.deepEqual(starts[0].tools.map(tool => tool.name), ['context_room_document', 'context_room_history']);
  assert.ok(turns[0].text.startsWith('My new explicit scoped question.')); assert.equal(turns[0].text.includes('Original delivery remains unknown.'), false);
  const history = await turns[0].tool('context_room_history', {}, { signal: new AbortController().signal }); assert.equal(history.legacy.originalThreadId, 'retained-task-original');
  assert.ok(history.messages.some(message => message.text === 'Original human question 🖊️'));
  assert.throws(() => service.legacyHistory(f.root, imported.conversationId, { offset: -1 }), /valid retained-history position/);
  f.revoke(); assert.throws(() => turns[0].tool('context_room_history', {}, { signal: new AbortController().signal }), { code: 'assistant_source_scope' });
  turns[0].onEvent({ type: 'completed', status: 'completed', failed: false });
});
