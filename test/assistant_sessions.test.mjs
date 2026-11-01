import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AssistantSessions } from '../src/assistant_sessions.mjs';
import { readNotebookJson, writeNotebookJson, notebookHash, stableNotebookJson } from '../src/notebook_io.mjs';
import { openNotebook, readNotebook, transferNotebook, relocateNotebook, encodeNotebook, followNotebook } from '../src/notebooks.mjs';
import { emptyNotebook } from '../src/notebook_protocol.mjs';
import { createAssistantSourceResolver } from '../src/assistant_sources.mjs';

async function until(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('Synthetic session did not settle'); await delay(10); } }
function providerFixture() {
  const turns = [], started = [], resumed = [], released = [];
  const provider = {
    models: [{ id: 'fixture' }],
    async startThread(input) { started.push(input); return { threadId: 'owned-codex-task', model: 'fixture' }; },
    async resumeOwnedThread(input) { resumed.push(input); return { threadId: input.threadId }; },
    releaseOwnedThread(threadId) { released.push(threadId); },
    async startTurn(input) { const turn = { ...input, turnId: 'turn-' + (turns.length + 1) }; turns.push(turn); input.onEvent({ type: 'started', turnId: turn.turnId }); return { threadId: input.threadId, turnId: turn.turnId }; },
    async interrupt(threadId) { const turn = turns.findLast(value => value.threadId === threadId); turn?.onEvent({ type: 'completed', turnId: turn.turnId, status: 'interrupted', failed: false }); },
    async close() {},
  };
  return { provider, turns, started, resumed, released, finish(text = 'Confirmed synthetic answer') {
    const active = turns.at(-1); active.onEvent({ type: 'text', delta: text }); active.onEvent({ type: 'completed', turnId: active.turnId, status: 'completed', failed: false });
  } };
}
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-sessions-')));
  const root = path.join(base, 'private'), original = path.join(base, 'original'), other = path.join(base, 'other');
  for (const directory of [root, original, other]) fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  let permitted = true; const calls = [];
  const resolveSource = (project, source) => {
    if (!permitted) throw Object.assign(new Error('Source permission revoked'), { code: 'source_permission' });
    if (source.path !== 'docs/Scene.crnb') throw new Error('Unknown synthetic source');
    return { source, title: 'Original synthetic scene', context: { project: path.basename(project), source }, tools: [],
      call: async (name, input) => { calls.push({ project, name, input }); return { confirmed: true }; } };
  };
  const services = []; t.after(async () => { await Promise.all(services.map(service => service.close())); });
  return { root, original, other, calls, revoke: () => { permitted = false; },
    service: providerFactory => { const service = new AssistantSessions({ root, resolveSource, providerFactory }); services.push(service); return service; },
    source: { kind: 'notebook', path: 'docs/Scene.crnb', resourceId: 'original', locationRevision: notebookHash('original-location') } };
}

test('creating and listing conversations never start a provider; duplicate sends run only once', async t => {
  const f = fixture(t), p = providerFixture(); let providerCalls = 0;
  const service = f.service(async () => { providerCalls++; return p.provider; }), requestId = randomUUID();
  const conversation = service.create(f.original, { requestId, source: f.source });
  assert.equal(service.create(f.original, { requestId, source: f.source }).id, conversation.id);
  assert.equal(service.list(f.original).length, 1); assert.equal(providerCalls, 0);
  const sendId = randomUUID(); service.send(f.original, conversation.id, { requestId: sendId, text: 'Draw in my original notebook' });
  service.send(f.original, conversation.id, { requestId: sendId, text: 'Draw in my original notebook' });
  assert.throws(() => service.send(f.other, conversation.id, { requestId: randomUUID(), text: 'Redirect' }), { code: 'assistant_scope' });
  assert.throws(() => service.send(f.original, conversation.id, { requestId: sendId, text: 'Different replay' }), { code: 'assistant_request_conflict' });
  await until(() => p.turns.length === 1); assert.equal(providerCalls, 1);
  assert.ok(p.turns[0].text.includes('"project":"original"'));
  await p.turns[0].tool('draw', { source: 'current original' }, {}); assert.equal(f.calls[0].project, f.original);
  p.finish(); await until(() => !service.running.size);
  const saved = service.get(f.original, conversation.id);
  assert.equal(saved.operation.status, 'completed'); assert.equal(saved.messages.length, 2); assert.equal(saved.messages[1].complete, true);
  assert.equal(service.list(f.original)[0].messages, undefined); assert.deepEqual(service.list(f.other), []);
  assert.equal(p.turns.length, 1);
});

test('history filters the complete retained store before paging and binds continuation to its exact source snapshot', t => {
  const f = fixture(t); let connections = 0;
  const service = f.service(() => { connections++; throw new Error('History must not start a provider'); });
  const templates = [f.other, f.original].map(root => {
    const created = service.create(root, { source: f.source }), state = service.read(created.id);
    fs.unlinkSync(path.join(f.root, service.file(created.id))); return state;
  });
  for (let i = 0; i < 624; i++) {
    const other = i < 501, state = structuredClone(templates[other ? 0 : 1]);
    state.id = `${other ? '00000000' : 'ffffffff'}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    state.origin.sessionId = state.id; state.updatedAt = new Date(Date.UTC(2024, 0, 1) + i).toISOString();
    state.origin.source.selection = i >= 601 ? ['selected-object'] : [];
    fs.writeFileSync(path.join(f.root, service.file(state.id)), JSON.stringify(state), { mode: 0o600 });
  }
  assert.equal(service.list(f.original).length, 123);
  const source = { ...f.source };
  const first = service.history(f.original, { source }); assert.equal(first.conversations.length, 50); assert.equal(first.pagination.total, 123);
  const ids = first.conversations.map(item => item.id); let cursor = first.pagination.nextCursor;
  while (cursor) { const page = service.history(f.original, { source, cursor }); ids.push(...page.conversations.map(item => item.id)); cursor = page.pagination.nextCursor; }
  assert.equal(new Set(ids).size, 123); assert.equal(ids.length, 123);
  const selected = service.history(f.original, { source, limit: 1, selectionHash: notebookHash(JSON.stringify([])) });
  assert.equal(selected.pagination.total, 100); assert.deepEqual(selected.conversations[0].source.selection, []);
  assert.throws(() => service.history(f.other, { source, cursor: first.pagination.nextCursor }), { code: 'assistant_history_cursor' });
  assert.throws(() => service.history(f.original, { source: { ...source, resourceId: 'other' }, cursor: first.pagination.nextCursor }), { code: 'assistant_history_cursor' });
  assert.deepEqual(service.history(f.original, { source: { ...source, locationRevision: notebookHash('another-location') } }).conversations, []);
  service.update(first.conversations[0].id, state => { state.model = 'configured-later'; });
  assert.throws(() => service.history(f.original, { source, cursor: first.pagination.nextCursor }), { code: 'assistant_history_changed' });
  assert.equal(connections, 0);
});

test('history refuses malformed limits and cursors without changing retained conversations', t => {
  const f = fixture(t), service = f.service(() => { throw new Error('No provider'); });
  const conversation = service.create(f.original, { source: f.source }), file = path.join(f.root, service.file(conversation.id)), before = fs.readFileSync(file);
  for (const limit of [0, 201, 1.5, 'NaN']) assert.throws(() => service.history(f.original, { limit }), { code: 'assistant_history_query' });
  for (const cursor of ['', 'invalid!', Buffer.from('null').toString('base64url')]) assert.throws(() => service.history(f.original, { cursor }), { code: 'assistant_history_cursor' });
  assert.throws(() => service.history(f.original, { source: { kind: 'document', path: 'docs/A.md', unrecognized: true } }), { code: 'assistant_history_query' });
  for (const locationRevision of [0, 1, '1', '', 'x'.repeat(64)]) assert.throws(() => service.history(f.original, { source: { ...f.source, locationRevision } }), { code: 'assistant_history_query' });
  assert.equal(fs.readFileSync(file).equals(before), true);
});

test('restart resumes the same owned Codex task with the preserved original context', async t => {
  const f = fixture(t), first = providerFixture(), a = f.service(async () => first.provider);
  const conversation = a.create(f.original, { source: f.source });
  a.send(f.original, conversation.id, { requestId: randomUUID(), text: 'First message' });
  await until(() => first.turns.length === 1); first.finish(); await until(() => !a.running.size); await a.close();
  const second = providerFixture(), b = f.service(async () => second.provider);
  b.send(f.original, conversation.id, { requestId: randomUUID(), text: 'Continue the same conversation' });
  await until(() => second.turns.length === 1);
  assert.equal(second.started.length, 0); assert.equal(second.resumed[0].threadId, 'owned-codex-task');
  assert.ok(second.turns[0].text.includes('"project":"original"'));
  second.finish('Continued, not copied'); await until(() => !b.running.size);
  assert.equal(b.get(f.original, conversation.id).threadId, 'owned-codex-task');
  assert.equal(b.get(f.original, conversation.id).messages.length, 4);
});

test('a stopped owner process leaves an uncertain receipt and never silently resends', async t => {
  const f = fixture(t); let calls = 0; const service = f.service(async () => { calls++; return providerFixture().provider; });
  const conversation = service.create(f.original, { source: f.source });
  const file = 'conversations/' + conversation.id + '.json', state = readNotebookJson(f.root, file);
  state.operation = { id: randomUUID(), status: 'running', owner: { pid: 2147483647, identity: 'old-process' } }; writeNotebookJson(f.root, file, state);
  assert.equal(service.get(f.original, conversation.id).operation.status, 'uncertain');
  assert.throws(() => service.send(f.original, conversation.id, { requestId: randomUUID(), text: 'Retry automatically' }), { code: 'assistant_busy' });
  assert.equal(calls, 0);
});

test('explicit recovery reconciles the original recorded turn without generating or copying a task', async t => {
  const f = fixture(t), p = providerFixture(); const inspections = [];
  p.provider.inspectOwnedTurn = async input => { inspections.push(input); return { turnId: 'exact-turn', status: 'completed', failed: false, answer: 'Recovered confirmed response.' }; };
  const service = f.service(async () => p.provider), conversation = service.create(f.original, { source: f.source }), requestId = randomUUID();
  service.update(conversation.id, state => {
    state.threadId = 'owned-codex-task'; state.operation = { id: requestId, status: 'uncertain', turnId: 'exact-turn', inputHash: 'recorded-input-hash' };
    state.messages = [{ id: requestId, role: 'user', text: 'Original request' }]; state.requests[requestId] = { status: 'uncertain' };
  });
  assert.equal(service.recover(f.original, conversation.id).recovery, 'inspecting');
  await until(() => service.get(f.original, conversation.id).recovery === 'confirmed');
  const recovered = service.get(f.original, conversation.id);
  assert.equal(recovered.operation.status, 'completed'); assert.equal(recovered.messages.at(-1).text, 'Recovered confirmed response.');
  assert.deepEqual(inspections, [{ threadId: 'owned-codex-task', turnId: 'exact-turn', inputHash: 'recorded-input-hash' }]);
  assert.equal(p.started.length, 0); assert.equal(p.turns.length, 0); assert.equal(p.resumed.length, 1);
  assert.deepEqual(p.released, ['owned-codex-task']);
});

test('a prepared original task is released if context resolution fails before generation', async t => {
  const f = fixture(t), p = providerFixture(), service = f.service(async () => p.provider);
  const resolve = service.resolveSource;
  service.resolveSource = (...args) => ({ ...resolve(...args), context: () => { throw new Error('Synthetic source changed before dispatch'); } });
  const conversation = service.create(f.original, { source: f.source });
  service.send(f.original, conversation.id, { requestId: randomUUID(), text: 'Keep this failed draft in the original task' });
  await until(() => !service.running.size);
  assert.equal(service.get(f.original, conversation.id).operation.status, 'failed');
  assert.equal(p.started.length, 1); assert.equal(p.turns.length, 0); assert.deepEqual(p.released, ['owned-codex-task']);
});

test('provider startup failure is visible and a later explicit send still includes original context', async t => {
  const f = fixture(t), p = providerFixture(); let count = 0;
  const service = f.service(async () => { if (++count === 1) throw new Error('Synthetic startup unavailable'); return p.provider; });
  const conversation = service.create(f.original, { source: f.source });
  service.send(f.original, conversation.id, { requestId: randomUUID(), text: 'First explicit request' });
  await until(() => !service.running.size);
  assert.equal(service.get(f.original, conversation.id).operation.status, 'failed');
  service.send(f.original, conversation.id, { requestId: randomUUID(), text: 'Second explicit request' });
  await until(() => p.turns.length === 1); assert.ok(p.turns[0].text.includes('"project":"original"'));
  p.finish(); await until(() => !service.running.size);
});

test('stop reaches the original provider task, and revoked source permissions block later access', async t => {
  const f = fixture(t), p = providerFixture(), service = f.service(async () => p.provider);
  const conversation = service.create(f.original, { source: f.source });
  service.send(f.original, conversation.id, { requestId: randomUUID(), text: 'Keep drawing until stopped' });
  await until(() => p.turns.length === 1); await service.stop(f.original, conversation.id); await until(() => !service.running.size);
  assert.equal(service.get(f.original, conversation.id).operation.status, 'stopped');
  const previous = service.get(f.original, conversation.id).operation.id;
  service.send(f.original, conversation.id, { requestId: randomUUID(), text: 'A later independent turn' });
  await until(() => p.turns.length === 2);
  await assert.rejects(() => service.stop(f.original, conversation.id, { operationId: previous }), { code: 'assistant_turn_changed' });
  assert.equal(service.get(f.original, conversation.id).operation.status, 'running');
  await service.stop(f.original, conversation.id); await until(() => !service.running.size);
  f.revoke(); assert.throws(() => service.get(f.original, conversation.id), { code: 'source_permission' });
});

test('conversation keeps Fast per conversation and legacy state defaults to off', async t => {
  const f = fixture(t), p = providerFixture(), service = f.service(async () => p.provider);
  const conversation = service.create(f.original, { source: f.source });
  assert.equal(conversation.fast, false);
  const other = service.create(f.original, { source: f.source });
  assert.equal(service.configure(f.original, conversation.id, { model: 'fixture', effort: 'low', fast: true }).fast, true);
  assert.equal(service.get(f.original, other.id).fast, false);
  service.send(f.original, conversation.id, { requestId: randomUUID(), text: 'Go' });
  await until(() => p.turns.length === 1); assert.equal(p.turns[0].fast, true);
  p.finish(); await until(() => !service.running.size);
  service.update(other.id, state => { delete state.fast; });
  assert.equal(service.get(f.original, other.id).fast, false);
  service.send(f.original, other.id, { requestId: randomUUID(), text: 'Go' });
  await until(() => p.turns.length === 2); assert.equal(p.turns[1].fast, false);
  p.finish(); await until(() => !service.running.size);
});

test('configure refuses a non-boolean Fast', t => {
  const f = fixture(t), service = f.service(() => { throw new Error('No provider'); });
  const conversation = service.create(f.original, { source: f.source });
  for (const fast of ['yes', 1, null]) assert.throws(() => service.configure(f.original, conversation.id, { model: 'fixture', effort: 'low', fast }), { code: 'assistant_model' });
  assert.throws(() => service.create(f.original, { source: f.source, fast: 'yes' }), { code: 'assistant_model' });
  assert.equal(service.get(f.original, conversation.id).fast, false);
});


/** Real notebooks in three private projects, the real source resolver and a synthetic provider. */
function notebookWorld(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-follow-')));
  const [store, A, B, C] = ['private', 'a', 'b', 'c'].map(name => { const dir = path.join(base, name); fs.mkdirSync(dir, { mode: 0o700 }); return dir; });
  const p = providerFixture(), allow = () => true;
  const resolveSource = createAssistantSourceResolver({ canRead: allow, canWrite: allow, proposeDocument: () => { throw new Error('No document here'); } });
  const service = new AssistantSessions({ root: store, resolveSource, providerFactory: async () => p.provider });
  t.after(async () => { await service.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const file = 'Carnets/Scene.crnb';
  const move = (from, to, id) => {
    const preview = transferNotebook(from, to, { resourceId: id, path: file }, { canWriteSource: allow, canWriteTarget: allow, preview: true });
    return transferNotebook(from, to, { resourceId: id, path: file, operationId: 'move-' + randomUUID(), expectedRevision: preview.revision }, { canWriteSource: allow, canWriteTarget: allow });
  };
  const sourceOf = scene => ({ kind: 'notebook', path: scene.locator.path, resourceId: scene.resourceId, revision: scene.revision, locationRevision: scene.locator.revision, selection: [] });
  // The exact query of src/ui/assistant.mjs, built from the notebook as this project sees it now.
  const query = (root, id) => { const scene = readNotebook(root, id, { includeDocument: false }); return { kind: 'notebook', path: scene.locator.path, resourceId: id, locationRevision: scene.locator.revision }; };
  const ids = (root, source) => service.history(root, { source, selectionHash: notebookHash(JSON.stringify([])) }).conversations.map(item => item.id).sort();
  return { base, store, A, B, C, p, service, file, move, sourceOf, query, ids, allow };
}

test('a real move A→B carries the conversation, its send and its retained history; A refuses it cleanly', async t => {
  const w = notebookWorld(t), scene = openNotebook(w.A, { path: w.file, canWrite: w.allow }), id = scene.resourceId;
  const plain = w.service.create(w.A, { source: w.sourceOf(scene) });
  const archiveBytes = Buffer.from(stableNotebookJson({ version: 1, original: { conversation: { id: 'old-conversation', thread: 'old-thread' } }, messages: [{ role: 'user', text: 'Retained message' }] }) + '\n');
  const legacy = { hash: notebookHash(archiveBytes), messageCount: 1, originalConversationId: 'old-conversation', originalThreadId: 'old-thread' };
  const retained = w.service.importRetainedConversation(w.A, { requestId: randomUUID(), legacy, archiveBytes,
    source: { ...w.sourceOf(scene), original: { revision: scene.revision, title: scene.document.title, selection: [] } } });
  const before = w.query(w.A, id);
  w.move(w.A, w.B, id);
  const here = w.query(w.B, id);
  assert.deepEqual(w.ids(w.B, here), [plain.id, retained.id].sort());
  const seen = w.service.get(w.B, plain.id);
  assert.equal(seen.source.path, here.path); assert.equal(seen.source.locationRevision, here.locationRevision);
  assert.equal(w.service.history(w.B, { source: here }).conversations[0].source.locationRevision, here.locationRevision);
  assert.equal(w.service.legacyHistory(w.B, retained.id).messages[0].text, 'Retained message');
  w.service.send(w.B, plain.id, { requestId: randomUUID(), text: 'Draw here' });
  await until(() => w.p.turns.length === 1);
  const result = await w.p.turns[0].tool('context_room_notebook', { action: 'scene' }, { callId: 'scene', turnId: w.p.turns[0].turnId, signal: new AbortController().signal });
  assert.equal(JSON.stringify(result).includes(here.locationRevision) || JSON.stringify(result).includes(id), true);
  w.p.finish(); await until(() => !w.service.running.size);
  assert.equal(w.service.get(w.B, plain.id).operation.status, 'completed');
  // The old root lists nothing and refuses every use with a clear code.
  assert.deepEqual(w.ids(w.A, before), []); assert.deepEqual(w.service.list(w.A), []);
  for (const use of [() => w.service.get(w.A, plain.id), () => w.service.legacyHistory(w.A, retained.id),
    () => w.service.send(w.A, plain.id, { requestId: randomUUID(), text: 'Old place' })]) assert.throws(use, { code: 'assistant_notebook_moved' });
  // A third project never sees it.
  assert.deepEqual(w.ids(w.C, here), []); assert.throws(() => w.service.get(w.C, plain.id), { code: 'assistant_scope' });
});

test('a chain A→B→C→A follows hop by hop, within the hop limit', t => {
  const w = notebookWorld(t), scene = openNotebook(w.A, { path: w.file, canWrite: w.allow }), id = scene.resourceId;
  const fromA = w.service.create(w.A, { source: w.sourceOf(scene) });
  w.move(w.A, w.B, id);
  const fromB = w.service.create(w.B, { source: w.sourceOf(readNotebook(w.B, id)) });
  w.move(w.B, w.C, id);
  assert.deepEqual(w.ids(w.C, w.query(w.C, id)), [fromA.id, fromB.id].sort());
  assert.equal(w.service.get(w.C, fromA.id).source.locationRevision, w.query(w.C, id).locationRevision);
  assert.throws(() => w.service.get(w.B, fromB.id), { code: 'assistant_notebook_moved' });
  assert.throws(() => w.service.get(w.B, fromA.id), { code: 'assistant_scope' });
  const origin = { root: w.A, rootIdentity: readNotebookJson(w.store, 'conversations/' + fromA.id + '.json').origin.rootIdentity, locationRevision: scene.locator.revision };
  assert.equal(followNotebook(w.C, id, origin, { maxHops: 1 }), null);
  assert.equal(followNotebook(w.C, id, origin, { maxHops: 2 }).locationRevision, w.query(w.C, id).locationRevision);
  // Back home: the first root's retired copy still proves its own departure.
  w.move(w.C, w.A, id);
  assert.deepEqual(w.ids(w.A, w.query(w.A, id)), [fromA.id, fromB.id].sort());
  assert.deepEqual(w.ids(w.C, w.query(w.A, id)), []);
});

test('a copied .crnb with the same resourceId sees no conversation of the original', t => {
  const w = notebookWorld(t), bytes = encodeNotebook(emptyNotebook('copied-scene', 'Copied'));
  for (const root of [w.A, w.B]) { fs.mkdirSync(path.join(root, 'Carnets'), { recursive: true }); fs.writeFileSync(path.join(root, w.file), bytes); }
  const original = openNotebook(w.A, { path: w.file, canWrite: w.allow }), copy = openNotebook(w.B, { path: w.file, canWrite: w.allow });
  assert.equal(copy.resourceId, original.resourceId);
  const conversation = w.service.create(w.A, { source: w.sourceOf(original) });
  assert.deepEqual(w.ids(w.B, w.query(w.B, 'copied-scene')), []);
  assert.throws(() => w.service.get(w.B, conversation.id), { code: 'assistant_scope' });
  assert.throws(() => w.service.send(w.B, conversation.id, { requestId: randomUUID(), text: 'Copy' }), { code: 'assistant_scope' });
  assert.deepEqual(w.ids(w.A, w.query(w.A, 'copied-scene')), [conversation.id]);
});

test('a relocation inside the same project keeps the history; a duplicate path does not inherit it', async t => {
  const w = notebookWorld(t), scene = openNotebook(w.A, { path: w.file, canWrite: w.allow }), id = scene.resourceId;
  const conversation = w.service.create(w.A, { source: w.sourceOf(scene) }), before = w.query(w.A, id);
  relocateNotebook(w.A, { resourceId: id, operationId: 'relocate-1', locationRevision: scene.locator.revision, path: 'Carnets/Renamed.crnb' }, { actor: { kind: 'human', id: 'fixture' }, canWrite: w.allow });
  const here = w.query(w.A, id);
  assert.equal(here.path, 'Carnets/Renamed.crnb');
  assert.deepEqual(w.ids(w.A, here), [conversation.id]);
  assert.equal(w.service.get(w.A, conversation.id).source.path, 'Carnets/Renamed.crnb');
  assert.deepEqual(w.ids(w.A, before), []);
  w.service.send(w.A, conversation.id, { requestId: randomUUID(), text: 'Still mine' });
  await until(() => w.p.turns.length === 1); w.p.finish(); await until(() => !w.service.running.size);
  assert.equal(w.service.get(w.A, conversation.id).operation.status, 'completed');
  // A copy of the file in the same project cannot take the identity, and its path finds nothing.
  fs.mkdirSync(path.join(w.A, 'Carnets'), { recursive: true });
  fs.writeFileSync(path.join(w.A, 'Carnets/Copy.crnb'), encodeNotebook({ ...readNotebook(w.A, id).document }));
  assert.throws(() => openNotebook(w.A, { path: 'Carnets/Copy.crnb', canWrite: w.allow }), { code: 'notebook_location_conflict' });
  assert.deepEqual(w.ids(w.A, { ...here, path: 'Carnets/Copy.crnb' }), []);
});

test('a repeated get does not replay the notebook; a move or a relocation after a cached get is still seen', t => {
  const w = notebookWorld(t), scene = openNotebook(w.A, { path: w.file, canWrite: w.allow }), id = scene.resourceId;
  const conversation = w.service.create(w.A, { source: w.sourceOf(scene) });
  const real = w.service.locateNotebook; let replays = 0;
  w.service.locateNotebook = (...args) => { replays++; return real(...args); };
  for (let i = 0; i < 5; i++) assert.equal(w.service.get(w.A, conversation.id).source.path, w.file);
  assert.equal(replays, 1);
  // A relocation changes the notebook history: the next get follows it, once.
  relocateNotebook(w.A, { resourceId: id, operationId: 'relocate-cache', locationRevision: scene.locator.revision, path: 'Carnets/Renamed.crnb' }, { actor: { kind: 'human', id: 'fixture' }, canWrite: w.allow });
  for (let i = 0; i < 3; i++) assert.equal(w.service.get(w.A, conversation.id).source.path, 'Carnets/Renamed.crnb');
  assert.equal(replays, 2);
  // A real move: the old project refuses at once, the new one follows, then both stay cached.
  w.move(w.A, w.B, id);
  assert.throws(() => w.service.get(w.A, conversation.id), { code: 'assistant_notebook_moved' });
  assert.equal(w.service.get(w.B, conversation.id).source.path, w.query(w.B, id).path);
  const after = replays;
  for (let i = 0; i < 3; i++) w.service.get(w.B, conversation.id);
  assert.equal(replays, after);
  // A third project is still refused.
  assert.throws(() => w.service.get(w.C, conversation.id), { code: 'assistant_scope' });
});
