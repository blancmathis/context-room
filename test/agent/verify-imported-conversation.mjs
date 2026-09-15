/** Opt-in real Codex check using only a new synthetic project and legacy archive. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { createCodexProvider } from '../../src/codex_provider.mjs';
import { createMemoryServer, initializeContextRoomProject, writeMemoryWebappSettings, migrateLisiereConversation } from '../../src/context_room.mjs';
import { openNotebook, readNotebook } from '../../src/notebooks.mjs';
import { notebookHash } from '../../src/notebook_io.mjs';
import { legacyConversationSnapshot } from '../fixtures/lisiere-conversations.mjs';

const option = name => { const at = process.argv.indexOf(name); return at < 0 ? '' : process.argv[at + 1] || ''; };
if (!process.argv.includes('--run') || !option('--output')) throw new Error('Explicit --run and a new private --output directory are required.');
const output = path.resolve(option('--output')); fs.mkdirSync(output, { mode: 0o700 });
const root = path.join(output, 'project'), storageRoot = path.join(output, 'private-assistant'); fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) process.env[key] = path.join(output, key);
fs.writeFileSync(path.join(root, 'docs/Other.md'), '# Independent original\nUnchanged human text.\n');
initializeContextRoomProject(root, { title: 'Synthetic recovered-history verification', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
const scene = openNotebook(root, { path: 'docs/Recovered.crnb', canWrite: () => true });
const legacy = await legacyConversationSnapshot(output, { desktop: true }), database = fs.readFileSync(path.join(legacy.source, 'workspace.sqlite'));
const input = { snapshot: legacy.snapshot, selector: legacy.selector, path: 'docs/Recovered.crnb' }, preview = migrateLisiereConversation(root, input, { storageRoot });
const imported = migrateLisiereConversation(root, { ...input, apply: true, expectedRevision: preview.revision }, { storageRoot });
const starts = [], resumes = [], calls = []; let connections = 0;
const room = createMemoryServer({ root, assistantOptions: { root: storageRoot, providerFactory: async options => {
  connections++; const provider = await createCodexProvider({ ...options, ...(option('--codex-state') ? { stateRoot: path.resolve(option('--codex-state')) } : {}) });
  const startThread = provider.startThread.bind(provider), resume = provider.resumeOwnedThread.bind(provider), startTurn = provider.startTurn.bind(provider);
  provider.startThread = async options => { const result = await startThread(options); starts.push(result.threadId); return result; };
  provider.resumeOwnedThread = async options => { resumes.push(options.threadId); return resume(options); };
  provider.startTurn = options => startTurn({ ...options, tool: async (name, input, metadata) => {
    const result = await options.tool(name, input, metadata); calls.push({ name, action: input?.action || null }); return result;
  } }); return provider;
} } });
await new Promise(resolve => room.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${room.server.address().port}`, browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [];
page.on('pageerror', failure => errors.push(failure.message));
try {
  await page.goto(base); await page.waitForFunction(() => Boolean(state.projectId && state.ownerMutationNonce));
  await page.evaluate(async () => { window.recoveryNotebook = await openContextRoomNotebook('docs/Recovered.crnb'); });
  await page.getByRole('button', { name: 'Ask about selection', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Original document conversation' });
  await page.waitForFunction(() => document.querySelector('.assistant-panel')?.dataset.ready === 'true');
  assert.equal(await pane.getByLabel('Saved conversations for this original source').inputValue(), imported.conversationId); assert.equal(connections, 0);
  await pane.getByRole('textbox').fill('Dans cette nouvelle conversation, lis le premier message retenu avec context_room_history. Puis utilise context_room_notebook pour ajouter un rectangle neuf id recovery-proof-box à x=80,y=90, largeur=240, hauteur=130, et un texte neuf id recovery-proof-label à x=90,y=120 contenant EXACTEMENT le texte de ce premier message. Lis la scène avant de dessiner. Ne relance aucune ancienne demande et ne modifie pas l’ancienne tâche. Confirme brièvement en français.');
  const started = performance.now(); await pane.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => recoveryNotebook.surface.document.objects.some(object => object.createdBy?.kind === 'agent'), null, { timeout: 120000 });
  const firstUsefulMs = Math.round(performance.now() - started);
  await page.waitForFunction(() => ['completed', 'failed', 'stopped', 'uncertain'].includes(document.querySelector('.assistant-panel')?.dataset.operationStatus), null, { timeout: 190000 });
  assert.equal(await pane.getAttribute('data-operation-status'), 'completed', await pane.locator('.assistant-status').innerText());
  const current = readNotebook(root, scene.resourceId), label = current.document.objects.find(object => object.id === 'recovery-proof-label');
  assert.equal(label?.text, 'Original human question 🖊️'); assert.ok(current.document.objects.some(object => object.id === 'recovery-proof-box' && object.type === 'rect'));
  assert.ok(calls.some(call => call.name === 'context_room_history')); assert.ok(calls.some(call => call.name === 'context_room_notebook' && call.action === 'scene'));
  assert.equal(starts.length, 1); assert.deepEqual(resumes, []); assert.notEqual(starts[0], imported.originalThreadId);
  assert.equal(fs.readFileSync(path.join(legacy.source, 'workspace.sqlite')).equals(database), true); assert.equal(fs.existsSync(path.join(root, 'docs/Recovered.crnb')), false);
  assert.equal(fs.readFileSync(path.join(root, 'docs/Other.md'), 'utf8'), '# Independent original\nUnchanged human text.\n'); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'real-recovered-history-drawing.png') });
  const sourceFiles = ['src/assistant_legacy.mjs', 'src/assistant_sessions.mjs', 'src/assistant_runtime.mjs', 'src/lisiere_conversations.mjs', 'src/context_room.mjs', 'src/ui/assistant.mjs', 'src/ui/assistant-legacy.mjs', 'src/notebooks.mjs'];
  fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify({ sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceFiles: Object.fromEntries(sourceFiles.map(file => [file, notebookHash(fs.readFileSync(file))])), provider: 'real local Codex', model: 'gpt-6-astra',
    syntheticOriginalIdentity: imported.originalThreadId, newTask: starts[0], originalTaskResumed: false, calls, firstUsefulMs,
    canonicalObjects: current.document.objects.length, ordinaryNotebookAbsent: true, otherDocumentUnchanged: true, originalDatabaseUnchanged: true, physicalDevice: false, pageErrors: errors }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ realProvider: true, originalTaskResumed: false, historyRead: true, canonicalObjects: current.document.objects.length, firstUsefulMs }));
} finally { await browser.close(); await new Promise(resolve => { room.server.closeAllConnections(); room.server.close(resolve); }); await room.waitForShutdown(); }
