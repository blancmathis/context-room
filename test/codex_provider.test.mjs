import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { CodexStdio, createCodexProvider } from '../src/codex_provider.mjs';

function fixture({ refuseRestriction = false, dottedName = false } = {}) {
  const children = [], requests = [], replies = [];
  let threadSequence = 0, turnSequence = 0;
  function launch(args) {
    const child = new EventEmitter(); children.push(child);
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null; child.args = args;
    child.send = value => child.stdout.write(JSON.stringify(value) + '\n');
    child.kill = signal => { child.signalCode = signal; child.emit('close', null); };
    child.stdin.on('finish', () => { child.exitCode = 0; child.emit('close', 0); });
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (!value.method) { replies.push(value); continue; }
        requests.push(value);
        const result = value.method === 'initialize' ? { userAgent: 'Fixture: no actual model' }
          : value.method === 'config/read' ? { config: {
            features: { shell_tool: false, apps: false, plugins: false, multi_agent: false }, web_search: 'disabled',
            mcp_servers: { [dottedName ? 'inherited.secret' : 'inherited-secret']: { enabled: refuseRestriction || !args.includes('mcp_servers.inherited-secret.enabled=false') },
              plain: { enabled: !args.includes('mcp_servers.plain.enabled=false') } },
          } }
          : value.method === 'model/list' ? { data: [{ id: 'fixture-model', displayName: 'Protocol fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] }
          : value.method === 'thread/start' ? { thread: { id: 'thread-' + ++threadSequence }, model: 'fixture-model' }
          : value.method === 'turn/start' ? { turn: { id: 'turn-' + ++turnSequence } }
          : value.method === 'turn/interrupt' ? {} : undefined;
        if (value.method === 'turn/start') child.send({ method: 'turn/started', params: { threadId: value.params.threadId, turn: result.turn } });
        if (result !== undefined) child.send({ id: value.id, result });
      }
    });
    return child;
  }
  return { launch, children, requests, replies, provider: () => createCodexProvider({ cwd: '/synthetic/owner', stateRoot: '/synthetic/state', launch }) };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const tool = { type: 'function', name: 'notebook_scene', description: 'Read the original synthetic scene', inputSchema: { type: 'object', additionalProperties: false, properties: {} } };

test('recovery reads only an owned exact turn and requires the recorded input hash', async t => {
  const f = fixture(), provider = await f.provider(); t.after(() => provider.close());
  const { threadId } = await provider.startThread({ instructions: 'Synthetic recovery', tools: [tool] });
  const input = 'Unique original input', inputHash = createHash('sha256').update(input).digest('hex');
  const requests = [], items = [ { type: 'userMessage', content: [{ type: 'text', text: input }] }, { type: 'reasoning', content: ['Not returned to UI'] }, { type: 'agentMessage', text: 'Recovered original answer.' } ];
  provider.rpc.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/turns/list') return { data: [{ id: 'original-turn', status: 'completed' }] };
    assert.equal(method, 'thread/items/list'); const index = Number(params.cursor || 0);
    return { data: [{ turnId: 'original-turn', item: items[index] }], nextCursor: index < items.length - 1 ? String(index + 1) : null };
  };
  await assert.rejects(provider.inspectOwnedTurn({ threadId: 'foreign', turnId: 'original-turn', inputHash }), { code: 'codex_thread_scope' });
  assert.equal(requests.length, 0);
  const recovered = await provider.inspectOwnedTurn({ threadId, turnId: 'original-turn', inputHash });
  assert.equal(recovered.answer, 'Recovered original answer.'); assert.equal(recovered.status, 'completed');
  assert.ok(requests.every(request => request.params.threadId === threadId));
  await assert.rejects(provider.inspectOwnedTurn({ threadId, turnId: 'original-turn', inputHash: 'wrong' }), { code: 'codex_recovery_uncertain' });
});

test('the provider explicitly disables every inherited MCP entry before starting a thread', async t => {
  const f = fixture(), provider = await f.provider(); t.after(() => provider.close());
  assert.equal(f.children.length, 2); assert.equal(f.children[0].exitCode, 0);
  assert.ok(f.children[1].args.includes('mcp_servers.inherited-secret.enabled=false'));
  assert.ok(f.children[1].args.includes('mcp_servers.plain.enabled=false'));
  assert.equal(f.requests.some(request => request.method === 'thread/start'), false);
  const { threadId } = await provider.startThread({ instructions: 'Synthetic scope', tools: [tool], model: 'fixture-model' });
  assert.equal(threadId, 'thread-1');
  const start = f.requests.find(request => request.method === 'thread/start').params;
  assert.deepEqual(start.environments, []); assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never');
  assert.deepEqual(start.dynamicTools, [tool]);
  await assert.rejects(provider.startThread({ model: 'unavailable' }), { code: 'codex_model_unavailable' });
});

test('an effective configuration that retains other tools fails before generation', async () => {
  const f = fixture({ refuseRestriction: true });
  await assert.rejects(f.provider(), { code: 'codex_scope_unavailable' });
  assert.ok(f.children.every(child => child.exitCode === 0));
  assert.equal(f.requests.some(request => request.method === 'thread/start'), false);
});

test('ambiguous CLI configuration keys fail closed instead of creating a different MCP entry', async () => {
  const f = fixture({ dottedName: true });
  await assert.rejects(f.provider(), { code: 'codex_scope_unavailable' });
  assert.equal(f.children.length, 1); assert.equal(f.children[0].exitCode, 0);
  assert.equal(f.requests.some(request => request.method === 'thread/start'), false);
});

test('only the original active thread, turn and declared tool can invoke a scoped action', async t => {
  const f = fixture(), provider = await f.provider(); t.after(() => provider.close());
  const { threadId } = await provider.startThread({ instructions: 'Original scene', tools: [tool] });
  let mutations = 0; const events = [];
  const active = await provider.startTurn({ threadId, text: 'Read the original scene', model: 'fixture-model', effort: 'low',
    tool: async () => { mutations++; return { revision: 3 }; }, onEvent: event => events.push(event) });
  const child = f.children.at(-1);
  const request = (id, changes = {}) => child.send({ id, method: 'item/tool/call', params: { threadId, turnId: active.turnId, callId: id, tool: tool.name, arguments: {}, ...changes } });
  request('good'); request('other-thread', { threadId: 'some-other-task' }); request('old-turn', { turnId: 'previous-turn' }); request('review', { tool: 'accept_file' });
  await turn();
  assert.equal(mutations, 1); assert.equal(f.replies.find(reply => reply.id === 'good').result.success, true);
  request('good-again', { callId: 'good' }); request('changed-replay', { callId: 'good', arguments: { changed: true } });
  await turn(); assert.equal(mutations, 1);
  assert.equal(f.replies.find(reply => reply.id === 'good-again').result.success, true);
  assert.ok(f.replies.find(reply => reply.id === 'changed-replay').error);
  for (const id of ['other-thread', 'old-turn', 'review']) assert.ok(f.replies.find(reply => reply.id === id).error);
  child.send({ method: 'item/agentMessage/delta', params: { threadId, turnId: active.turnId, itemId: 'answer', delta: 'Original scene r3' } });
  child.send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'previous-turn', delta: 'Stale answer' } });
  assert.equal(events.filter(event => event.type === 'text').length, 1);
  await provider.interrupt(threadId); request('after-stop'); await turn();
  assert.equal(mutations, 1); assert.ok(f.replies.find(reply => reply.id === 'after-stop').error);
  child.send({ method: 'turn/completed', params: { threadId, turn: { id: active.turnId, status: 'interrupted' } } });
  assert.equal(events.at(-1).status, 'interrupted');
  await assert.rejects(provider.startTurn({ threadId: 'external-desktop-thread', text: 'Resume' }), { code: 'codex_thread_scope' });
});

test('interruption aborts in-flight progressive work before the provider acknowledges it', async t => {
  const f = fixture(), provider = await f.provider(); t.after(() => provider.close());
  const { threadId } = await provider.startThread({ tools: [tool] });
  let signal, resolveAction;
  const active = await provider.startTurn({ threadId, text: 'Synthetic progressive operation', tool: (_, __, options) => {
    signal = options.signal; return new Promise(resolve => { resolveAction = resolve; });
  } });
  f.children.at(-1).send({ id: 'slow', method: 'item/tool/call', params: { threadId, turnId: active.turnId, callId: 'slow', tool: tool.name, arguments: {} } });
  await turn(); assert.equal(signal.aborted, false);
  const interrupted = provider.interrupt(threadId); assert.equal(signal.aborted, true);
  resolveAction({ stoppedAtReachedPoint: true }); await interrupted; await turn();
});

test('stdio handles fragmented frames, late replies and malformed input without retrying', async t => {
  const f = fixture(), rpc = new CodexStdio({ cwd: '/synthetic', launch: f.launch }); t.after(() => rpc.close());
  await rpc.initialize();
  const pending = rpc.request('not-replied', {}, 15), id = f.requests.at(-1).id;
  await assert.rejects(pending, { code: 'codex_timeout' });
  assert.equal(f.requests.filter(request => request.method === 'not-replied').length, 1);
  f.children[0].send({ id, result: { tooLate: true } });
  const next = rpc.request('fragmented', {}), nextId = f.requests.at(-1).id;
  const line = JSON.stringify({ id: nextId, result: { intact: true } }) + '\n';
  f.children[0].stdout.write(line.slice(0, 9)); f.children[0].stdout.write(line.slice(9));
  assert.deepEqual(await next, { intact: true });
  const failure = once(rpc, 'failure'); f.children[0].stdout.write('invalid protocol\n');
  assert.equal((await failure)[0].code, 'codex_protocol');
  await assert.rejects(rpc.request('no-restart'), { code: 'codex_disconnected' });
});
