/** Opt-in live-account verification, isolated from personal projects and installations. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createCodexProvider } from '../../src/codex_provider.mjs';
import { initializeContextRoomProject, writeMemoryWebappSettings, createMemoryServer, writeDocReviewDecision } from '../../src/context_room.mjs';
import { listNotebooks, readNotebook } from '../../src/notebooks.mjs';
import { listLocalProposals, readLocalProposalFile } from '../../src/local_proposals.mjs';

const option = name => { const index = process.argv.indexOf(name); return index < 0 ? '' : process.argv[index + 1] || ''; };
if (!process.argv.includes('--run') || !option('--output')) throw new Error('Explicit --run and a new private --output directory are required.');
const output = path.resolve(option('--output')), resuming = process.argv.includes('--resume'); if (!resuming) fs.mkdirSync(output, { mode: 0o700 });
const root = path.join(output, 'original'), other = path.join(root, 'docs/Other.md'); fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) process.env[key] = path.join(output, key);
if (!resuming) {
fs.writeFileSync(path.join(root, 'docs/Original.md'), '# Une idée originale\n\nMon texte humain est conservé.\n');
fs.writeFileSync(other, '# Autre document\n\nCe texte indépendant ne doit pas changer.\n');
initializeContextRoomProject(root, { title: 'Isolated real conversation verification', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
// Synthetic acceptance setup only; actual agent proposals cannot make decisions.
writeDocReviewDecision(root, 'docs/Original.md', { status: 'verified' }); writeDocReviewDecision(root, 'docs/Other.md', { status: 'verified' });
}
const originalBytes = fs.readFileSync(path.join(root, 'docs/Original.md')), otherBytes = fs.readFileSync(other);
const room = createMemoryServer({ root, assistantOptions: { root: path.join(output, 'private-conversations'),
  providerFactory: options => createCodexProvider({ ...options, ...(option('--codex-state') ? { stateRoot: path.resolve(option('--codex-state')) } : {}) }) } });
await new Promise(resolve => room.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${room.server.address().port}`, browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
async function waitComplete(pane) {
  await page.waitForFunction(() => ['completed', 'failed', 'stopped', 'uncertain'].includes(document.querySelector('.assistant-panel')?.dataset.operationStatus), null, { timeout: 190_000 });
  assert.equal(await pane.getAttribute('data-operation-status'), 'completed', await pane.locator('.assistant-status').innerText());
}
try {
  await page.goto(base); await page.waitForFunction(() => Boolean(state.projectId && state.ownerMutationNonce));
  await page.evaluate(async () => { window.realNotebook = await openContextRoomNotebook('docs/Sketch.crnb'); });
  await page.getByRole('button', { name: 'Ask about selection', exact: true }).click();
  let pane = page.getByRole('complementary', { name: 'Original document conversation' });
  const started = performance.now(); let firstUsefulMs = null;
  if (!resuming) {
  await pane.getByRole('textbox').fill('Dessine maintenant dans ce carnet un rectangle de 200 par 100 à x=80,y=90 avec le libellé "Idée originale", puis un nouveau trait manuscrit dessous avec draw pendant 1800 ms. Préserve mon travail. Fais les vrais appels aux outils et confirme brièvement en français.');
  await pane.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => realNotebook.surface.document.objects.some(object => object.createdBy?.kind === 'agent'), null, { timeout: 120_000 });
  firstUsefulMs = Math.round(performance.now() - started); await waitComplete(pane);
  } else {
    const saved = await (await fetch(base + '/api/assistant/conversations')).json();
    const original = saved.conversations.find(item => item.source.path === 'docs/Sketch.crnb' && item.threadId);
    assert.ok(original, 'The original notebook task is required for explicit resumption');
    await pane.getByLabel('Saved conversations for this original source').selectOption(original.id); await waitComplete(pane);
  }
  const notebook = listNotebooks(root)[0], scene = readNotebook(root, notebook.id);
  assert.ok(scene.document.objects.some(object => object.type === 'text' && object.text.includes('Idée originale')));
  assert.ok(scene.document.objects.some(object => object.type === 'ink' && object.points.length > 1));
  await page.screenshot({ path: path.join(output, 'real-notebook-conversation.png') });
  await page.getByRole('button', { name: 'Close notebook', exact: true }).click();
  await page.evaluate(() => selectFile('docs/Original.md'));
  await page.getByRole('button', { name: 'Discuss', exact: true }).click();
  await page.evaluate(() => selectFile('docs/Other.md'));
  pane = page.getByRole('complementary', { name: 'Original document conversation' });
  await pane.getByRole('textbox').fill('Dans le document d’origine, prépare une proposition de modification qui conserve mon texte et ajoute exactement la phrase "La conversation reste liée à ce document.". Utilise ton outil de proposition. Ne touche aucun autre document et ne valide rien.');
  await pane.getByRole('button', { name: 'Send', exact: true }).click(); await waitComplete(pane);
  const proposals = listLocalProposals(root); assert.equal(proposals.length, 1); assert.deepEqual(proposals[0].changes.map(change => change.path), ['docs/Original.md']);
  const proposed = readLocalProposalFile(root, proposals[0].id, 'docs/Original.md').afterBytes.toString('utf8');
  assert.ok(proposed.includes('Mon texte humain est conservé.')); assert.ok(proposed.includes('La conversation reste liée à ce document.'));
  assert.deepEqual(fs.readFileSync(path.join(root, 'docs/Original.md')), originalBytes); assert.deepEqual(fs.readFileSync(other), otherBytes);
  await page.screenshot({ path: path.join(output, 'real-document-conversation.png') });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify({ sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: true,
    provider: 'real local Codex', model: 'gpt-6-astra', firstUsefulMs, notebookReusedWithoutNewTurn: resuming, notebookAgentObjects: scene.document.objects.filter(object => object.createdBy?.kind === 'agent').length,
    proposal: proposals[0].id, acceptedFileUnchanged: true, otherDocumentUnchanged: true, navigationPreservedOriginalSource: true,
    pageErrors: errors, audio: 'separate verification', physicalBoox: 'not-tested' }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ firstUsefulMs, notebookAgentObjects: scene.document.objects.length, proposalCreated: true, acceptedFileUnchanged: true, otherDocumentUnchanged: true }));
} finally {
  await browser.close(); await new Promise(resolve => { room.server.closeAllConnections(); room.server.close(resolve); }); await room.waitForShutdown();
}
