/** Opt-in real-account acceptance. Synthetic content only; no default test invokes a model. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCodexProvider } from '../../src/codex_provider.mjs';
import { NOTEBOOK_AGENT_TOOL, NotebookAgentContext } from '../../src/notebook_agent.mjs';
import { openNotebook, mutateNotebook, readNotebook, encodeNotebook } from '../../src/notebooks.mjs';
import { emptyNotebook } from '../../src/notebook_protocol.mjs';
import { notebookHash } from '../../src/notebook_io.mjs';
import { notebookSvg } from '../../src/notebook_render.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, output: { type: 'string' }, 'codex-state': { type: 'string' }, model: { type: 'string', default: 'gpt-6-astra' } } });
const repo = fileURLToPath(new URL('../..', import.meta.url));
if (!values.run || !values.output || !path.isAbsolute(values.output) || fs.existsSync(values.output)
  || values.output === repo || values.output.startsWith(repo + path.sep)) throw new Error('Use --run and a new private --output directory outside the checkout.');
fs.mkdirSync(values.output, { recursive: true, mode: 0o700 });
const output = fs.realpathSync(values.output), root = path.join(output, 'original'), other = path.join(output, 'other');
for (const directory of [root, other]) fs.mkdirSync(path.join(directory, 'docs'), { recursive: true, mode: 0o700 });
const rel = 'docs/Scene.crnb', canWrite = value => value === rel;
fs.writeFileSync(path.join(root, rel), encodeNotebook(emptyNotebook('real-agent-scene', 'Synthetic co-drawing')));
const acceptedBefore = notebookHash(fs.readFileSync(path.join(root, rel)));
const scene = openNotebook(root, { path: rel, canWrite });
const foreign = openNotebook(other, { id: 'other-scene', path: rel, canWrite });
mutateNotebook(root, { protocolVersion: 1, resourceId: scene.resourceId, locationRevision: scene.locator.revision,
  operationId: 'human-original-note', edits: [{ kind: 'put', id: 'human-note', expectedRevision: 0,
    object: { type: 'text', x: 30, y: 30, text: 'Mon idée humaine reste ici', fontSize: 20, color: '#111111' } }] },
{ actor: { kind: 'human', id: 'synthetic-owner' }, canWrite });
const context = new NotebookAgentContext({ root, resourceId: scene.resourceId, locationRevision: scene.locator.revision,
  sessionId: randomUUID(), selection: ['human-note'], canRead: canWrite, canWrite });
const humanBefore = context.scene().document.objects.find(object => object.id === 'human-note');
const events = [], calls = [], progress = [];
let provider, timer, activeThreadId, firstUsefulMs = null, startedAt;
const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
try {
  provider = await createCodexProvider({ cwd: output, ...(values['codex-state'] ? { stateRoot: values['codex-state'] } : {}) });
  const model = provider.models.find(item => item.id === values.model);
  assert.ok(model?.efforts.includes('low'), 'The selected real model must support low reasoning effort');
  const thread = await provider.startThread({ model: model.id, tools: [NOTEBOOK_AGENT_TOOL], instructions:
    'You are the real Context Room notebook collaborator. The sole tool is bound to the original notebook. Read its scene. Preserve human work. Use new stable object IDs and exact expectedRevision values. Working changes are never review decisions. Object types are rect, ellipse, line, arrow, text, ink, image and connector. Rectangles use x,y,width,height; text uses x,y,text,fontSize,color; arrows use x,y,x2,y2. An edit is {kind:"put",id,expectedRevision:0,object:{id,type,...}}. Ink uses points [[x,y,pressure],...], color and strokeWidth. Use draw for a new progressive stroke. Do not claim work that the tool has not confirmed.' });
  activeThreadId = thread.threadId;
  const completion = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('The real Codex turn did not finish within 120 seconds.')), 120_000);
    context.onEvent = event => {
      events.push({ atMs: Math.round(performance.now() - startedAt), ...event });
      if (event.type === 'completed') resolve(event);
      else if (['uncertain', 'disconnected'].includes(event.type)) reject(new Error('The real provider lost this turn: ' + event.type));
    };
  });
  // Register rejection handling before the asynchronous turn/start call.
  completion.catch(() => {});
  startedAt = performance.now();
  const turn = await provider.startTurn({ threadId: thread.threadId, model: model.id, effort: 'low',
    text: 'Dessine maintenant un petit schéma lisible de trois étapes : Idée → Dessin → Relecture. Compose toi-même sa disposition sous mon annotation existante. Conserve mon texte humain. Ajoute aussi un court trait manuscrit neuf sous le schéma, avec draw sur 600 ms, pour vérifier la pointe progressive. Fais les vrais appels aux outils, puis réponds brièvement en français.',
    onEvent: event => context.onEvent(event),
    tool: async (name, input, options) => {
      const call = { action: input.action, callId: options.callId, atMs: Math.round(performance.now() - startedAt) }; calls.push(call);
      const result = await context.call(name, input, { ...options, onProgress: event => {
        const atMs = Math.round(performance.now() - startedAt); firstUsefulMs ??= atMs; progress.push({ atMs, ...event });
      } });
      if (input.action === 'edit') firstUsefulMs ??= Math.round(performance.now() - startedAt);
      call.confirmed = true; return result;
    },
  });
  const complete = await completion; clearTimeout(timer);
  assert.equal(complete.status, 'completed'); assert.equal(complete.failed, false);
  const final = readNotebook(root, scene.resourceId).document;
  const agentObjects = final.objects.filter(object => object.createdBy.kind === 'agent');
  assert.ok(agentObjects.length >= 4, 'A real composition must have been persisted');
  assert.ok(agentObjects.some(object => object.type === 'ink' && object.points.length > 1));
  for (const word of ['Idée', 'Dessin', 'Relecture']) assert.ok(agentObjects.some(object => object.type === 'text' && object.text.includes(word)), 'Missing real generated label: ' + word);
  assert.ok(progress.length >= 2 && progress.at(-1).completed, 'The pen must advance through confirmed intermediate states');
  assert.deepEqual(final.objects.find(object => object.id === 'human-note'), humanBefore);
  assert.equal(final.objects.find(object => object.id === 'human-note').revision, 1);
  assert.equal(readNotebook(other, foreign.resourceId).revision, 0);
  assert.equal(notebookHash(fs.readFileSync(path.join(root, rel))), acceptedBefore);
  fs.writeFileSync(path.join(output, 'scene.crnb'), encodeNotebook(final), { mode: 0o600 });
  fs.writeFileSync(path.join(output, 'scene.svg'), notebookSvg(final, { showOrigins: true }), { mode: 0o600 });
  save('proof.json', { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()),
    provider: 'real-local-codex-stdio', model: model.id, effort: 'low', ...turn, acceptedFileUnchanged: true,
    humanObjectUnchanged: true, otherProjectUnchanged: true, agentObjects: agentObjects.length,
    firstUsefulMs, totalMs: Math.round(performance.now() - startedAt), progressiveReceipts: progress.length, ui: 'not-tested', physicalBoox: 'not-tested' });
  console.log('Real Codex composition confirmed; first useful result:', firstUsefulMs, 'ms');
} catch (error) { save('failure.json', { code: error.code || 'acceptance_failed', message: error.message }); if (activeThreadId) await provider?.interrupt(activeThreadId).catch(() => {}); throw error; }
finally { clearTimeout(timer); save('events.json', events); save('calls.json', calls); save('progress.json', progress); await provider?.close(); }
