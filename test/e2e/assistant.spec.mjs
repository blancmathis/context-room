import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { assistantFixture } from '../fixtures/assistant.mjs';
import { readNotebook } from '../../src/notebooks.mjs';

test('@smoke @assistant conversation keeps its original document across navigation and explicit history resumption', async ({ page }, testInfo) => {
  const f = await assistantFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md'));
    await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }); await expect(pane).toBeVisible();
    await expect(pane.locator('.assistant-origin')).toHaveText('docs/Original.md'); expect(f.connections()).toBe(0);
    await page.evaluate(() => selectFile('docs/Other.md'));
    await pane.getByRole('textbox').fill('Discuss the original document, while I read another.');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(1); expect(f.turns[0].text).toContain('Human original content.'); expect(f.turns[0].text).not.toContain('Independent human content.');
    f.finish(); await expect(pane).toHaveAttribute('data-operation-status', 'completed');
    await expect(pane.getByRole('log')).toContainText('Synthetic contract answer');
    await pane.locator('summary').filter({ hasText: 'Codex model' }).click();
    await pane.getByRole('button', { name: 'Load available models' }).click();
    await expect(pane.getByLabel('Conversation Codex model')).toContainText('Synthetic model contract');
    await pane.getByRole('textbox').fill('Continue the same original task.'); await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(2); expect(f.starts.length).toBe(1); expect(f.resumes.length).toBe(1);
    await pane.getByRole('button', { name: 'Stop agent', exact: true }).click(); await expect(pane).toHaveAttribute('data-operation-status', 'stopped');
    expect(fs.readFileSync(path.join(f.root, 'docs/Other.md'), 'utf8')).toContain('Independent human content.');
    await page.screenshot({ path: testInfo.outputPath('original-conversation.png') });
    const accessibility = await new AxeBuilder({ page }).include('.assistant-panel').analyze(); expect(accessibility.violations).toEqual([]); expect(errors).toEqual([]);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant notebook co-drawing reaches the canonical scene and the conversation survives closing its notebook', async ({ page }, testInfo) => {
  const f = await assistantFixture();
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(async () => { window.notebookUnderTest = await openContextRoomNotebook('docs/Sketch.crnb'); });
    const notebook = page.getByRole('dialog', { name: 'Notebook: docs/Sketch.crnb', exact: true });
    await expect(notebook).toHaveAttribute('data-save-state', 'confirmed');
    await notebook.getByRole('button', { name: 'Ask about selection', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }); await expect(pane).toBeVisible();
    await pane.getByRole('textbox').fill('Draw a synthetic rectangle in the original notebook.'); await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(1); const turn = f.turns[0];
    const receipt = await turn.tool('context_room_notebook', { action: 'edit', edits: [{ kind: 'put', id: 'synthetic-agent-box', expectedRevision: 0, object: { type: 'rect', x: 80, y: 100, width: 180, height: 130 } }] }, { callId: 'draw', turnId: turn.turnId, signal: new AbortController().signal });
    f.finish('Synthetic rectangle is saved as working ink.');
    await expect.poll(() => page.evaluate(() => notebookUnderTest.surface.document.objects.length)).toBe(1);
    expect(readNotebook(f.root, receipt.resourceId).document.objects[0].createdBy.kind).toBe('agent');
    await pane.getByRole('button', { name: 'Minimize conversation' }).click();
    await page.screenshot({ path: testInfo.outputPath('notebook-conversation.png') });
    await notebook.getByRole('button', { name: 'Close notebook', exact: true }).click(); await expect(pane).toBeVisible();
    await expect(pane.locator('.assistant-origin')).toHaveText('docs/Sketch.crnb'); expect(fs.existsSync(path.join(f.root, 'docs/Sketch.crnb'))).toBe(false);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant an unsent draft survives reload in its original conversation without starting Codex', async ({ page }) => {
  const f = await assistantFixture();
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md', { reviewMode: true })); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' });
    const history = pane.getByLabel('Saved conversations for this original source'); await expect(history).not.toHaveValue(''); const id = await history.inputValue();
    await pane.getByRole('textbox').fill('Keep this private draft with its original source.');
    await expect.poll(() => page.evaluate(async id => {
      const { readDraft } = await import('/assets/ui/assistant-drafts.mjs'); return (await readDraft(captureNotebookApi().scopeKey, id)).text;
    }, id)).toBe('Keep this private draft with its original source.');
    await page.reload(); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    await expect(history).toHaveValue(id); await expect(pane.getByRole('textbox')).toHaveValue('Keep this private draft with its original source.');
    expect(f.connections()).toBe(0);
    await pane.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(history).not.toHaveValue(id); await expect(pane.getByRole('textbox')).toHaveValue('');
    await history.selectOption(id); await expect(pane.getByRole('textbox')).toHaveValue('Keep this private draft with its original source.');
    expect(f.connections()).toBe(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant a stopped dictation and late playback cannot send or acknowledge audio in another operation', async ({ page }) => {
  let transcriptions = 0;
  const f = await assistantFixture({ audio: {
    async transcribe() { transcriptions++; return { text: 'Synthetic original-source dictation.', silent: false, submitted: false }; },
    async synthesize(text) { return { text, pcm: Buffer.alloc(4800).toString('base64'), sampleRate: 24000, played: false }; },
  } });
  const receipts = []; page.on('request', request => { if (request.url().endsWith('/api/assistant/audio/receipt')) receipts.push(request.postDataJSON()); });
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    // Synthetic bridge only for response-ordering contracts; device tests use
    // the actual Java bridge, permission dialog, AudioRecord and AudioTrack.
    await page.evaluate(() => {
      const state = window.syntheticAudio = { acknowledgments: [], plays: [], stops: [] };
      window.ContextRoomNativeOwner = {
        active: true, async ensureMicrophone() {}, async audioController() {},
        async startRecording() { return { recordingId: '00000000-0000-0000-0000-000000000010' }; },
        finishRecording() { return new Promise(resolve => { state.finish = resolve; }); },
        async cancelRecording() {}, async releaseAudio(value) { state.stops.push(value); },
        async recoverRecordings() { return { recordings: [] }; }, async acknowledgeRecording(value) { state.acknowledgments.push(value); },
        playAudio(value) { return new Promise(resolve => { state.plays.push({ value, resolve }); }); }, async stopAudio() {},
      };
    });
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }), history = pane.getByLabel('Saved conversations for this original source');
    await pane.getByRole('button', { name: 'Dictate', exact: true }).click(); await expect(pane.getByRole('button', { name: 'Finish dictation' })).toBeVisible();
    await expect(history).toBeDisabled(); const id = await history.inputValue();
    await pane.getByRole('button', { name: 'Finish dictation' }).click(); await page.waitForFunction(() => Boolean(syntheticAudio.finish));
    await pane.getByRole('button', { name: 'Stop audio', exact: true }).click();
    await page.evaluate(() => syntheticAudio.finish({ recordingId: '00000000-0000-0000-0000-000000000010', pcm: btoa('\0'.repeat(6400)) }));
    await expect(pane.getByRole('button', { name: 'Retry dictation' })).toBeEnabled(); expect(transcriptions).toBe(0); expect(f.connections()).toBe(0);
    await pane.getByRole('button', { name: 'Retry dictation' }).click();
    await expect(pane.getByRole('textbox')).toHaveValue('Synthetic original-source dictation.'); expect(transcriptions).toBe(1); expect(f.turns).toHaveLength(0);
    expect(await page.evaluate(() => syntheticAudio.acknowledgments[0].conversationId)).toBe(id);
    await pane.getByRole('button', { name: 'Send', exact: true }).click(); await expect.poll(() => f.turns.length).toBe(1); f.finish('Read this exact synthetic answer.');
    await expect(pane).toHaveAttribute('data-operation-status', 'completed'); await pane.getByRole('button', { name: 'Read answer' }).click();
    await page.waitForFunction(() => syntheticAudio.plays.length === 1); await expect(history).toBeDisabled();
    await pane.getByRole('button', { name: 'Stop audio', exact: true }).click();
    await page.evaluate(() => syntheticAudio.plays[0].resolve({ played: true })); await expect(history).toBeEnabled(); expect(receipts).toHaveLength(0);
    await pane.getByRole('button', { name: 'Read answer' }).click(); await page.waitForFunction(() => syntheticAudio.plays.length === 2);
    await page.evaluate(() => syntheticAudio.plays[1].resolve({ played: true })); await expect.poll(() => receipts.length).toBe(1); expect(receipts[0].conversationId).toBe(id);
    await expect(pane.locator('.assistant-audio-state')).toHaveText('Microphone off · audio stopped.');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});
