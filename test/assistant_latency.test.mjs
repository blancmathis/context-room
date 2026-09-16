import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCodexProvider } from '../src/codex_provider.mjs';
import { AssistantSessions } from '../src/assistant_sessions.mjs';
import { AssistantTiming } from '../src/assistant_timing.mjs';
import { initializeConversationInput } from '../src/ui/assistant.mjs';
import { createAssistantSourceResolver } from '../src/assistant_sources.mjs';
import { openNotebook, readNotebook } from '../src/notebooks.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function stdioFixture({ servers = 'none', restrictionIgnored = false, featureIgnored = false, malformed = false, lingerProbe = false } = {}) {
  const children = [], requests = [];
  const launch = args => {
    const child = new EventEmitter(), probe = children.length === 0; children.push(child);
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    child.kill = signal => { child.signalCode = signal; child.emit('close'); };
    child.stdin.on('finish', () => { if (lingerProbe && probe) return; child.exitCode = 0; child.emit('close', 0); });
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const n = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); requests.push(request);
        if (!Object.hasOwn(request, 'id')) continue;
        let result;
        if (request.method === 'initialize') result = {};
        else if (request.method === 'config/read') result = malformed ? {} : { config: {
          features: { shell_tool: featureIgnored, apps: false, plugins: false, multi_agent: false }, web_search: 'disabled',
          mcp_servers: servers === 'none' ? {} : { inherited: { enabled: servers !== 'disabled' && (restrictionIgnored || !args.includes('mcp_servers.inherited.enabled=false')) } },
        } };
        else if (request.method === 'model/list') result = { data: [] };
        else throw new Error('No model turn belongs in a startup fixture: ' + request.method);
        child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
      }
    });
    return child;
  };
  return { launch, children, requests };
}

for (const servers of ['none', 'disabled']) test(`synthetic startup: ${servers} inherited MCP needs one verified child, not a second cold initialization`, async () => {
  const f = stdioFixture({ servers });
  const provider = await createCodexProvider({ cwd: '/synthetic/restricted', launch: f.launch });
  try {
    assert.equal(f.children.length, 1);
    assert.equal(f.requests.filter(r => r.method === 'initialize').length, 1);
    assert.equal(f.requests.filter(r => r.method === 'config/read').length, 1);
    assert.equal(f.requests.filter(r => r.method === 'model/list').length, 1);
    assert.equal(provider.setupTiming.restartRequired, false);
    assert.equal(provider.setupTiming.stages.isolationShutdownMs, undefined);
    assert.ok(provider.setupTiming.totalMs >= provider.setupTiming.stages.initialInitializeMs);
  } finally { await provider.close(); }
});

test('synthetic startup: active inherited MCP still requires restart and verified disabled configuration', async () => {
  const f = stdioFixture({ servers: 'enabled' });
  const provider = await createCodexProvider({ cwd: '/synthetic/restricted', launch: f.launch });
  try {
    assert.equal(f.children.length, 2); assert.equal(f.children[0].exitCode, 0);
    assert.equal(f.requests.filter(r => r.method === 'config/read').length, 2);
    assert.equal(provider.setupTiming.restartRequired, true);
    for (const stage of ['initialInitializeMs', 'initialConfigurationMs', 'isolationShutdownMs', 'restrictedInitializeMs', 'restrictedConfigurationMs', 'modelCatalogMs'])
      assert.ok(Number.isFinite(provider.setupTiming.stages[stage]));
  } finally { await provider.close(); }
});

test('an idle initialization probe receives SIGTERM without the active-session five-second grace', async () => {
  const f = stdioFixture({ servers: 'enabled', lingerProbe: true });
  const opening = createCodexProvider({ cwd: '/synthetic/restricted', launch: f.launch });
  await tick(); await tick();
  try {
    assert.equal(f.children[0].signalCode, 'SIGTERM');
    assert.equal(f.children.length, 2);
    const provider = await opening; await provider.close();
  } finally { for (const child of f.children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
});

for (const input of [{ featureIgnored: true }, { malformed: true }, { servers: 'enabled', restrictionIgnored: true }])
  test('startup refuses unverified restrictions before model listing: ' + JSON.stringify(input), async () => {
    const f = stdioFixture(input);
    await assert.rejects(createCodexProvider({ cwd: '/synthetic/restricted', launch: f.launch }), { code: 'codex_scope_unavailable' });
    assert.equal(f.requests.some(r => ['model/list', 'thread/start', 'turn/start'].includes(r.method)), false);
    assert.ok(f.children.every(c => c.exitCode === 0));
  });

test('saved draft, not the delayed history catalogue, gates sending to the original source', async () => {
  const draft = deferred(), history = deferred(), calls = [];
  const opening = initializeConversationInput({ restoreDraft: () => draft.promise,
    ready: () => calls.push('ready'), loadHistory: () => { calls.push('history'); return history.promise; },
    onError: error => calls.push(error.message) });
  await tick(); assert.deepEqual(calls, []);
  draft.resolve(); await opening;
  assert.deepEqual(calls, ['ready', 'history']);
  history.reject(new Error('Synthetic catalogue failure')); await tick();
  assert.deepEqual(calls, ['ready', 'history', 'Synthetic catalogue failure']);
});

test('failed draft recovery cannot enable send or load another conversation', async () => {
  const calls = [];
  await assert.rejects(initializeConversationInput({ restoreDraft: async () => { throw new Error('Draft unavailable'); },
    ready: () => calls.push('ready'), loadHistory: () => calls.push('history'), onError: () => calls.push('error') }), /Draft unavailable/);
  assert.deepEqual(calls, []);
});

test('monotonic timing is bounded metadata, distinguishes milestones and never reports inferred model time', () => {
  let now = 100;
  const timing = new AssistantTiming({ now: () => now });
  timing.mark('queued'); now += 10; timing.mark('providerReady'); now += 50; timing.mark('firstProviderText');
  now += 250; timing.mark('firstSavedText'); timing.mark('firstProviderText'); timing.addTool(15);
  const snapshot = timing.snapshot();
  assert.equal(snapshot.milestones.firstProviderText, 60); assert.equal(snapshot.milestones.firstSavedText, 310);
  assert.equal(snapshot.toolWorkSumMs, 15); assert.equal(snapshot.inferenceTimeMeasured, false); assert.equal(snapshot.displayTimeMeasured, false);
  snapshot.milestones.queued = 999; assert.equal(timing.snapshot().milestones.queued, 0);
  assert.throws(() => timing.mark('/private/prompt'), /Unknown/);
});

async function sessionFixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-first-result-'))), root = path.join(base, 'project'), store = path.join(base, 'private');
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(store, { mode: 0o700 });
  const canWrite = p => p === 'docs/Scene.crnb';
  const scene = openNotebook(root, { path: 'docs/Scene.crnb', canWrite });
  const source = { kind: 'notebook', path: scene.locator.path, resourceId: scene.resourceId, revision: scene.revision, locationRevision: scene.locator.revision, selection: [] };
  const started = deferred(); let calls = 0;
  const provider = { async startThread() { return { threadId: 'synthetic-thread' }; }, async resumeOwnedThread() {},
    async startTurn(input) { calls++; input.onEvent({ type: 'started', turnId: 'synthetic-turn' }); started.resolve(input); return { turnId: 'synthetic-turn' }; },
    async interrupt() {}, async close() {} };
  const service = new AssistantSessions({ root: store, providerFactory: async () => provider,
    resolveSource: createAssistantSourceResolver({ canRead: (_root, p) => canWrite(p), canWrite: (_root, p) => canWrite(p) }) });
  const conversation = service.create(root, { source }), request = { requestId: randomUUID(), text: 'Synthetic protocol input, no actual model' };
  t.after(async () => { await service.close(); fs.rmSync(base, { recursive: true, force: true }); });
  service.send(root, conversation.id, request);
  const job = service.running.get(conversation.id), turn = await started.promise;
  return { root, store, scene, service, conversation, request, job, turn, calls: () => calls };
}

test('first provider text is durably readable in the same callback, later deltas remain coalesced', async t => {
  const f = await sessionFixture(t);
  f.turn.onEvent({ type: 'text', delta: 'First actual event' });
  const persisted = JSON.parse(fs.readFileSync(path.join(f.store, f.service.file(f.conversation.id))));
  assert.equal(persisted.messages[1].text, 'First actual event'); assert.equal(persisted.messages[1].complete, false);
  const before = f.service.get(f.root, f.conversation.id).operation.timing;
  assert.ok(before.milestones.firstSavedText >= before.milestones.firstProviderText);
  f.turn.onEvent({ type: 'text', delta: ' plus a later delta' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.store, f.service.file(f.conversation.id)))).messages[1].text, 'First actual event');
  f.service.send(f.root, f.conversation.id, f.request); assert.equal(f.calls(), 1);
  f.turn.onEvent({ type: 'completed', status: 'completed', failed: false }); await f.job.completion;
  const after = f.service.get(f.root, f.conversation.id);
  assert.equal(after.messages[1].text, 'First actual event plus a later delta'); assert.equal(after.messages[1].complete, true);
  assert.deepEqual(after.operation.timing, JSON.parse(fs.readFileSync(path.join(f.store, f.service.file(f.conversation.id)))).operation.timing);
  assert.equal(after.operation.timing.milestones.firstProviderText, before.milestones.firstProviderText);
  assert.equal(after.operation.timing.milestones.firstMutation, undefined);
});

test('real notebook tool records first durable geometry separately from provider and display time', async t => {
  const f = await sessionFixture(t);
  await f.turn.tool('context_room_notebook', { action: 'draw', durationMs: 300,
    stroke: { id: 'drawn', type: 'ink', points: [[0, 0, 1], [100, 0, 1]] } }, { callId: 'synthetic-call', turnId: 'synthetic-turn' });
  const timing = f.service.get(f.root, f.conversation.id).operation.timing;
  assert.ok(timing.milestones.firstToolCall >= timing.milestones.dispatch);
  assert.ok(timing.milestones.firstMutation >= timing.milestones.firstToolCall);
  assert.ok(timing.milestones.firstDrawSegment >= timing.milestones.firstMutation);
  assert.ok(timing.toolWorkSumMs > 0); assert.equal(timing.milestones.firstProviderText, undefined);
  assert.equal(readNotebook(f.root, f.scene.resourceId).document.objects.length, 1);
  assert.equal(fs.existsSync(path.join(f.root, f.scene.locator.path)), false);
  f.turn.onEvent({ type: 'completed', status: 'completed', failed: false }); await f.job.completion;
  assert.equal(f.service.get(f.root, f.conversation.id).operation.timing.displayTimeMeasured, false);
});
