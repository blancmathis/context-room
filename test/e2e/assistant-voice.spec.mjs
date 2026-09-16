import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { assistantFixture } from '../fixtures/assistant.mjs';

async function openOriginal(page, url) {
  await page.goto(url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
  await page.evaluate(() => selectFile('docs/Original.md'));
  await page.getByRole('button', { name: 'Discuss', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Original document conversation' });
  await expect(pane.getByLabel('Saved conversations for this original source')).not.toHaveValue(''); return pane;
}
async function syntheticBridge(page) {
  await page.evaluate(() => {
    const audio = window.voiceContract = { captures: [], plays: [], acknowledgments: [] };
    window.ContextRoomNativeOwner = {
      active: true, async ensureMicrophone() {}, async audioController() {}, async releaseAudio() {},
      async conversationState(value) { audio.conversation = value; },
      async recoverRecordings() { return { recordings: [] }; },
      async startRecording(value) { const recordingId = crypto.randomUUID(); audio.captures.push({ ...value, recordingId }); return { recordingId }; },
      async finishRecording(value) { return { ...value, pcm: btoa('\0'.repeat(6400)), sampleRate: 16000 }; },
      async cancelRecording() {}, async acknowledgeRecording(value) { audio.acknowledgments.push(value); },
      playAudio(value) { return new Promise(resolve => audio.plays.push({ ...value, resolve })); },
      async stopAudio() { audio.plays.at(-1)?.resolve({ played: false }); },
    };
  });
}
async function speech(page, type) {
  await page.evaluate(type => window.dispatchEvent(new CustomEvent('context-room-native-audio', { detail: { type, recordingId: voiceContract.captures.at(-1).recordingId } })), type);
}

test('@smoke @assistant unfinished microphone chunks recover after reload only in their original conversation', async ({ page }) => {
  let transcriptions = 0;
  const f = await assistantFixture({ audio: { async transcribe() { transcriptions++; return { text: 'Recovered original audio.', silent: false }; } } });
  try {
    let pane = await openOriginal(page, f.url);
    const id = await pane.getByLabel('Saved conversations for this original source').inputValue();
    await page.evaluate(async id => {
      const audio = await import('/assets/ui/assistant-drafts.mjs'), scope = captureNotebookApi().scopeKey;
      const legacyParts = JSON.parse(scope); legacyParts[2] = legacyParts[1]; const legacy = JSON.stringify(legacyParts);
      await audio.journalRecording(legacy, id, 'original-crash-recording', 16000, [new Float32Array(8000).fill(.1)], 0, 8000);
      await audio.journalRecording(legacy, id, 'original-crash-recording', 16000, [new Float32Array(8000).fill(.2)], 1, 16000);
      await audio.journalRecording(scope + '-different-project', id, 'other-recording', 16000, [new Float32Array(8000)], 0, 8000);
      let failed = false; try { await audio.journalRecording(legacy, id, 'original-crash-recording', 16000, [new Float32Array(10)], 0, 10); } catch { failed = true; }
      if (!failed) throw new Error('Out-of-order capture must retain its previous journal');
    }, id);
    await page.reload(); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    pane = page.getByRole('complementary', { name: 'Original document conversation' });
    await pane.getByRole('button', { name: 'Recover dictation', exact: true }).click();
    expect(transcriptions).toBe(0); expect(f.connections()).toBe(0);
    await pane.getByRole('button', { name: 'Retry dictation', exact: true }).click();
    await expect(pane.getByRole('textbox')).toHaveValue('Recovered original audio.');
    expect(transcriptions).toBe(1); expect(f.turns).toHaveLength(0);
    const counts = await page.evaluate(async id => {
      const { browserRecordings } = await import('/assets/ui/assistant-drafts.mjs'), scope = captureNotebookApi().scopeKey;
      return [(await browserRecordings(scope, id)).length, (await browserRecordings(scope + '-different-project', id)).length];
    }, id); expect(counts).toEqual([0, 1]);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant explicit Voice interrupts the original agent, speaks its answer and resumes listening until ended', async ({ page }, testInfo) => {
  let transcriptions = 0; const errors = [], receipts = [];
  const f = await assistantFixture({ audio: {
    async transcribe() { return { text: 'Synthetic spoken phrase ' + ++transcriptions, silent: false }; },
    async synthesize(text) { return { text, pcm: Buffer.alloc(4800).toString('base64'), sampleRate: 24000, played: false }; },
  } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/assistant/audio/receipt')) receipts.push(request.postDataJSON()); });
  try {
    const pane = await openOriginal(page, f.url); await syntheticBridge(page);
    await pane.getByRole('button', { name: 'Voice', exact: true }).click();
    await expect(pane).toHaveAttribute('data-voice-state', 'listening'); expect(f.connections()).toBe(0);
    await speech(page, 'speech-start'); await speech(page, 'speech-end');
    await expect.poll(() => f.turns.length).toBe(1); await page.waitForFunction(() => voiceContract.captures.length === 2);
    await page.evaluate(() => selectFile('docs/Other.md'));
    await speech(page, 'speech-start'); await expect(pane).toHaveAttribute('data-operation-status', 'stopped');
    await speech(page, 'speech-end'); await expect.poll(() => f.turns.length).toBe(2);
    expect(f.starts).toHaveLength(1); expect(f.turns[1].text).toContain('Human original content.'); expect(f.turns[1].text).not.toContain('Independent human content.');
    await page.waitForFunction(() => voiceContract.captures.length === 3); f.finish('This synthetic answer belongs to the original source.');
    await page.waitForFunction(() => voiceContract.plays.length === 1); await expect(pane).toHaveAttribute('data-voice-state', 'speaking');
    await pane.getByRole('button', { name: 'Interrupt and speak', exact: true }).click();
    await page.waitForFunction(() => voiceContract.captures.length === 4); expect(receipts).toHaveLength(0);
    await speech(page, 'speech-start'); await speech(page, 'speech-end');
    await expect.poll(() => f.turns.length).toBe(3); await page.waitForFunction(() => voiceContract.captures.length === 5);
    f.finish('A second exact synthetic spoken answer.'); await page.waitForFunction(() => voiceContract.plays.length === 2);
    await page.evaluate(() => voiceContract.plays[1].resolve({ played: true }));
    await page.waitForFunction(() => voiceContract.captures.length === 6); await expect.poll(() => receipts.length).toBe(1);
    await pane.getByRole('button', { name: 'End voice', exact: true }).click(); await expect(pane).toHaveAttribute('data-voice-state', 'off');
    const counts = await page.evaluate(() => voiceContract.captures.length); await page.waitForTimeout(650); expect(await page.evaluate(() => voiceContract.captures.length)).toBe(counts);
    expect(errors).toEqual([]); await page.screenshot({ path: testInfo.outputPath('voice-original-source.png') });
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant ending Voice during transcription retains audio without a late send or microphone restart', async ({ page }) => {
  let complete; const f = await assistantFixture({ audio: { transcribe() { return new Promise(resolve => { complete = resolve; }); } } });
  try {
    const pane = await openOriginal(page, f.url); await syntheticBridge(page);
    await pane.getByRole('button', { name: 'Voice', exact: true }).click(); await expect(pane).toHaveAttribute('data-voice-state', 'listening');
    await speech(page, 'speech-start'); await speech(page, 'speech-end'); await expect.poll(() => Boolean(complete)).toBe(true);
    await pane.getByRole('button', { name: 'End voice', exact: true }).click(); complete({ text: 'Late synthetic transcription.', silent: false });
    await expect(pane).toHaveAttribute('data-voice-state', 'off'); await expect(pane.getByRole('button', { name: 'Retry dictation', exact: true })).toBeEnabled();
    expect(f.turns).toHaveLength(0); expect(await page.evaluate(() => voiceContract.captures.length)).toBe(1);
    await pane.getByRole('button', { name: 'New conversation', exact: true }).click(); await expect(pane.getByRole('textbox')).toHaveValue('');
    expect(f.connections()).toBe(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant a background audio release survives reload and cannot occupy the next microphone', async ({ page }) => {
  const f = await assistantFixture();
  try {
    let pane = await openOriginal(page, f.url); await syntheticBridge(page);
    await pane.getByRole('button', { name: 'Dictate', exact: true }).click(); await expect(pane.getByRole('button', { name: 'Finish dictation', exact: true })).toBeVisible();
    await page.evaluate(() => { ContextRoomNativeOwner.active = false; window.dispatchEvent(new CustomEvent('context-room-native-active', { detail: false })); });
    await expect.poll(() => page.evaluate(async () => {
      const { pendingAudioReleases } = await import('/assets/ui/assistant-drafts.mjs'); return (await pendingAudioReleases(captureNotebookApi().scopeKey)).length;
    })).toBe(1);
    pane = await openOriginal(page, f.url); await syntheticBridge(page);
    await expect(pane).toHaveAttribute('data-ready', 'true');
    await pane.getByRole('button', { name: 'Dictate', exact: true }).click(); await expect(pane.getByRole('button', { name: 'Finish dictation', exact: true })).toBeVisible();
    expect(await page.evaluate(async () => { const { pendingAudioReleases } = await import('/assets/ui/assistant-drafts.mjs'); return (await pendingAudioReleases(captureNotebookApi().scopeKey)).length; })).toBe(0);
    expect(f.connections()).toBe(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant native conversation layout keeps the notebook dialog and its working state for return', async ({ page }, testInfo) => {
  const f = await assistantFixture();
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId)); await syntheticBridge(page);
    await page.evaluate(async () => { window.retainedNativeNotebook = await openContextRoomNotebook('docs/Sketch.crnb'); });
    await page.waitForFunction(() => document.querySelector('.notebook-dialog')?.dataset.saveState === 'confirmed');
    await page.evaluate(async projectId => {
      const binding = retainedNativeNotebook.binding();
      await window.openContextRoomNativeConversation({ kind: 'notebook', projectId, resourceId: binding.resourceId, path: binding.path,
        revision: binding.revision, locationRevision: binding.locationRevision, selection: binding.selection });
    }, f.room.projectId);
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }); await expect(pane).toBeVisible();
    await pane.getByRole('textbox').fill('Keep this original notebook draft while I draw.');
    await page.waitForFunction(() => voiceContract.conversation?.hasDraft === true);
    expect(await page.evaluate(() => voiceContract.conversation.source.resourceId)).toBe(await page.evaluate(() => retainedNativeNotebook.resourceId));
    await page.screenshot({ path: testInfo.outputPath('retained-native-conversation-layout.png') });
    await page.evaluate(() => window.setContextRoomNativeConversationView(false));
    await expect(page.locator('.notebook-dialog canvas')).toBeVisible();
    await expect(pane.getByRole('textbox')).toHaveValue('Keep this original notebook draft while I draw.');
    expect(await page.evaluate(() => retainedNativeNotebook.dialog.open)).toBe(true); expect(f.connections()).toBe(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant a legacy root draft is recovered once without resurrecting explicitly cleared text', async ({ page }) => {
  const f = await assistantFixture();
  try {
    let pane = await openOriginal(page, f.url), id = await pane.getByLabel('Saved conversations for this original source').inputValue();
    await page.evaluate(async id => {
      const { writeDraft } = await import('/assets/ui/assistant-drafts.mjs'), parts = JSON.parse(captureNotebookApi().scopeKey); parts[2] = parts[1];
      await writeDraft(JSON.stringify(parts), id, { text: 'Retain the original legacy root draft.', sendRequest: null, recording: null });
    }, id);
    pane = await openOriginal(page, f.url); await expect(pane.getByRole('textbox')).toHaveValue('Retain the original legacy root draft.');
    await pane.getByRole('textbox').fill('');
    await expect.poll(() => page.evaluate(async id => { const { readDraft } = await import('/assets/ui/assistant-drafts.mjs'); return (await readDraft(captureNotebookApi().scopeKey, id)).text; }, id)).toBe('');
    pane = await openOriginal(page, f.url); await expect(pane.getByRole('textbox')).toHaveValue(''); expect(f.connections()).toBe(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant Stop agent stays in view when a small conversation panel scrolls', async ({ page }) => {
  const f = await assistantFixture();
  try {
    await page.setViewportSize({ width: 390, height: 500 });
    const pane = await openOriginal(page, f.url);
    await pane.getByRole('textbox').fill('Synthetic waiting turn. '.repeat(120));
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(pane).toHaveAttribute('data-operation-status', 'running');
    await pane.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const stop = pane.getByRole('button', { name: 'Stop agent', exact: true });
    await expect(stop).toBeInViewport({ ratio: 0.99 });
    await stop.click(); await expect(pane).toHaveAttribute('data-operation-status', 'stopped');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant a long answer completes more than 24 speech passages exactly once', async ({ page }) => {
  const spoken = [], errors = [], answer = 'A complete synthetic spoken passage for the original document. '.repeat(210);
  const f = await assistantFixture({ audio: { async synthesize(text) { spoken.push(text); return { text, pcm: 'AAA=', sampleRate: 24000, played: false }; } } });
  page.on('pageerror', error => errors.push(error.message));
  try {
    const pane = await openOriginal(page, f.url); await syntheticBridge(page);
    await page.evaluate(() => { ContextRoomNativeOwner.playAudio = async value => { voiceContract.plays.push(value); return { played: true }; }; });
    await pane.getByRole('textbox').fill('Prepare the synthetic long answer.'); await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(1); f.finish(answer);
    await expect(pane).toHaveAttribute('data-operation-status', 'completed');
    await pane.getByRole('button', { name: 'Read answer', exact: true }).click();
    await expect.poll(() => spoken.join(''), { timeout: 30000 }).toBe(answer);
    await expect(pane.getByRole('button', { name: 'Read answer', exact: true })).toBeEnabled();
    expect(spoken.length).toBeGreaterThan(24);
    expect(await page.evaluate(() => voiceContract.plays.length)).toBe(spoken.length);
    expect(await page.evaluate(() => voiceContract.captures.length)).toBe(0);
    expect(errors).toEqual([]); expect(f.turns).toHaveLength(1);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant direct dictation starts once and retains its original source while navigation continues', async ({ page }, testInfo) => {
  const f = await assistantFixture({ audio: { async transcribe() { return { text: 'Review this original spoken draft.', silent: false }; } } });
  const original = fs.readFileSync(path.join(f.root, 'docs/Original.md'), 'utf8'), other = fs.readFileSync(path.join(f.root, 'docs/Other.md'), 'utf8');
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId)); await syntheticBridge(page);
    await page.evaluate(() => selectFile('docs/Original.md'));
    await page.locator('[data-file-dictate]').dblclick();
    const pane = page.getByRole('complementary', { name: 'Original source dictation' });
    await expect(pane.getByRole('button', { name: 'Finish dictation', exact: true })).toBeVisible();
    expect(await page.evaluate(() => voiceContract.captures.length)).toBe(1);
    await page.evaluate(() => selectFile('docs/Other.md'));
    await pane.getByRole('button', { name: 'Finish dictation', exact: true }).click();
    await expect(pane.getByRole('textbox')).toHaveValue('Review this original spoken draft.');
    await expect(pane.locator('.assistant-origin')).toHaveText('docs/Original.md');
    expect(f.connections()).toBe(0); expect(f.turns).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath('direct-original-dictation.png') });
    await pane.getByRole('button', { name: 'Append to document draft', exact: true }).click();
    await expect(pane.getByRole('alert')).toContainText('Return to the unchanged original document draft');
    expect(await page.locator('#docEditor').inputValue()).toBe(other);
    await page.evaluate(() => selectFile('docs/Original.md'));
    await pane.getByRole('button', { name: 'Append to document draft', exact: true }).click();
    await expect(page.locator('#docEditor')).toHaveValue(original + 'Review this original spoken draft.');
    await pane.getByRole('button', { name: 'Append to document draft', exact: true }).click();
    await expect(pane.getByRole('alert')).toContainText('Return to the unchanged original document draft');
    expect(await page.locator('#docEditor').inputValue()).toBe(original + 'Review this original spoken draft.');
    const undo = await page.evaluate(() => isMacPlatform() ? 'Meta+z' : 'Control+z');
    await page.locator('#docEditor').press(undo); await expect(page.locator('#docEditor')).toHaveValue(original);
    expect(fs.readFileSync(path.join(f.root, 'docs/Original.md'), 'utf8')).toBe(original);
    expect(fs.readFileSync(path.join(f.root, 'docs/Other.md'), 'utf8')).toBe(other);
    await pane.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await expect(pane).toHaveCount(0);
    const conversation = page.getByRole('complementary', { name: 'Original document conversation' });
    await expect(conversation.getByRole('textbox')).toHaveValue('Review this original spoken draft.');
    expect(await page.evaluate(() => voiceContract.captures.length)).toBe(1);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant silent dictation leaves the existing original draft unchanged', async ({ page }) => {
  const f = await assistantFixture({ audio: { async transcribe() { return { text: '', silent: true }; } } });
  try {
    const pane = await openOriginal(page, f.url); await syntheticBridge(page);
    const original = 'An existing original draft.\n';
    await pane.getByRole('textbox').fill(original);
    await pane.getByRole('button', { name: 'Dictate', exact: true }).click();
    await pane.getByRole('button', { name: 'Finish dictation', exact: true }).click();
    await expect(pane.locator('.assistant-info')).toContainText('No speech detected');
    await expect(pane.getByRole('textbox')).toHaveValue(original);
    expect(f.connections()).toBe(0); expect(f.turns).toHaveLength(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant direct notebook dictation creates a retained text draft before an explicit human addition', async ({ page }, testInfo) => {
  const f = await assistantFixture({ audio: { async transcribe() { return { text: 'A dictated notebook idea.', silent: false }; } } });
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId)); await syntheticBridge(page);
    await page.evaluate(async () => { window.dictatedNotebook = await openContextRoomNotebook('docs/Dictated.crnb'); });
    const notebook = page.getByRole('dialog', { name: 'Notebook: docs/Dictated.crnb', exact: true });
    await expect(notebook).toHaveAttribute('data-save-state', 'confirmed');
    await notebook.getByRole('button', { name: 'Dictate text', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original source dictation' });
    await pane.getByRole('button', { name: 'Finish dictation', exact: true }).click();
    await expect(pane.getByRole('textbox')).toHaveValue('A dictated notebook idea.');
    await pane.getByRole('button', { name: 'Copy into notebook text draft', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await dictatedNotebook.client.state()).metadata.textDraft?.text)).toBe('A dictated notebook idea.');
    expect(await page.evaluate(() => dictatedNotebook.surface.document.objects.length)).toBe(0);
    await pane.getByRole('button', { name: 'Close dictation', exact: true }).click();
    await expect(notebook.getByLabel('Notebook text draft')).toHaveValue('A dictated notebook idea.');
    await page.screenshot({ path: testInfo.outputPath('dictated-notebook-text-draft.png') });
    await notebook.getByRole('button', { name: 'Add text', exact: true }).click();
    await expect.poll(() => page.evaluate(() => dictatedNotebook.surface.document.objects.length)).toBe(1);
    expect(await page.evaluate(() => dictatedNotebook.surface.document.objects[0].createdBy.kind)).toBe('human');
    expect(f.connections()).toBe(0); expect(f.turns).toHaveLength(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant direct Voice starts from the document and switching to Dictate preserves control of the original source', async ({ page }) => {
  const f = await assistantFixture();
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId)); await syntheticBridge(page);
    await page.evaluate(() => selectFile('docs/Original.md'));
    await page.locator('[data-file-voice]').click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' });
    await expect(pane).toHaveAttribute('data-voice-state', 'listening');
    await expect(pane.getByRole('region', { name: 'Recovered recordings' })).toBeHidden();
    await page.locator('[data-file-dictate]').click();
    const dictation = page.getByRole('complementary', { name: 'Original source dictation' });
    await expect(dictation).toHaveAttribute('data-voice-state', 'off');
    await expect(dictation.getByRole('button', { name: 'Finish dictation', exact: true })).toBeVisible();
    expect(await page.evaluate(() => voiceContract.captures.length)).toBe(2);
    await dictation.getByRole('button', { name: 'Close dictation', exact: true }).click();
    expect(f.connections()).toBe(0); expect(f.turns).toHaveLength(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});
