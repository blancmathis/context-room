/** Opt-in real-account eviction/resume acceptance; synthetic text and owned tasks only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCodexProvider } from '../../src/codex_provider.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, output: { type: 'string' }, 'codex-state': { type: 'string' }, model: { type: 'string', default: 'gpt-6-astra' } } });
const repo = fileURLToPath(new URL('../..', import.meta.url));
if (!values.run || !values.output || !path.isAbsolute(values.output) || fs.existsSync(values.output)
  || values.output === repo || values.output.startsWith(repo + path.sep)) throw new Error('Use --run and a new private --output directory outside the checkout.');
fs.mkdirSync(values.output, { mode: 0o700 });
const output = fs.realpathSync(values.output), calls = [], events = [], marker = 'synthetic-' + randomUUID();
let provider, activeThreadId;
const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
async function speak(threadId, text) {
  activeThreadId = threadId; let timer, answer = '', resolve, reject;
  const terminal = new Promise((yes, no) => { resolve = yes; reject = no; timer = setTimeout(() => no(new Error('The original real turn did not complete.')), 120000); });
  terminal.catch(() => {});
  try {
    const started = await provider.startTurn({ threadId, text, model: values.model, effort: 'low', onEvent(event) {
      events.push({ threadId, ...event });
      if (event.type === 'text') answer += event.delta;
      if (event.type === 'completed') resolve(event);
      if (['uncertain', 'disconnected'].includes(event.type)) reject(new Error(event.message));
    } });
    const result = await terminal; assert.equal(result.status, 'completed'); assert.equal(result.failed, false);
    activeThreadId = null; return { ...started, answer };
  } finally { clearTimeout(timer); provider.releaseOwnedThread(threadId); }
}
try {
  provider = await createCodexProvider({ cwd: output, maxResidentThreads: 1, ...(values['codex-state'] ? { stateRoot: values['codex-state'] } : {}) });
  assert.ok(provider.models.find(model => model.id === values.model)?.efforts.includes('low'));
  const request = provider.rpc.request.bind(provider.rpc);
  provider.rpc.request = async (method, params, ...rest) => {
    const result = await request(method, params, ...rest);
    if (['thread/start', 'thread/resume', 'thread/unsubscribe', 'turn/start'].includes(method)) calls.push({ method, threadId: params.threadId || result.thread?.id, ...(method === 'thread/unsubscribe' ? { status: result.status } : {}) });
    return result;
  };
  const original = await provider.startThread({ model: values.model, tools: [], instructions: 'This is an explicit synthetic Context Room conversation continuity check. Do not access files or tools. Follow the user request using only this conversation.' });
  const first = await speak(original.threadId, 'Retiens ce repère synthétique pour notre conversation : ' + marker + '. Réponds seulement Reçu.');
  const temporary = await provider.startThread({ model: values.model, tools: [], instructions: 'Synthetic empty residency check. No generation is requested.' });
  provider.releaseOwnedThread(temporary.threadId);
  assert.equal(provider.threads.has(original.threadId), false); assert.equal(provider.threads.size, 1);
  const resumed = await provider.resumeOwnedThread({ threadId: original.threadId, tools: [] });
  assert.equal(resumed.threadId, original.threadId); assert.equal(provider.threads.has(temporary.threadId), false);
  const second = await speak(resumed.threadId, 'Réponds uniquement par le repère synthétique mémorisé dans notre échange précédent.');
  assert.ok(second.answer.includes(marker), 'The resumed original task must retain its unreplayed prior exchange');
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 2);
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 1);
  assert.equal(calls.filter(call => call.method === 'thread/unsubscribe').length, 2);
  assert.ok(calls.filter(call => call.method === 'turn/start').every(call => call.threadId === original.threadId));
  const proof = { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()), provider: 'real local Codex',
    capacity: 1, maximumResidentObserved: 1, originalThreadId: original.threadId, emptyTemporaryThreadId: temporary.threadId,
    first, second, originalHistoryRetained: true, priorInputReplayed: false, generationsInOriginalTask: 2,
    unsubscribe: calls.filter(call => call.method === 'thread/unsubscribe'), personalTasksUsed: false };
  save('proof.json', proof); console.log('Real bounded residency and exact original history resume: passed.');
} catch (error) { save('failure.json', { code: error.code || 'acceptance_failed', message: error.message }); if (activeThreadId) await provider?.interrupt(activeThreadId).catch(() => {}); throw error; }
finally { save('calls.json', calls); save('events.json', events); await provider?.close(); }
