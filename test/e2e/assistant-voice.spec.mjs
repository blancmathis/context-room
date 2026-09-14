import { test, expect } from '@playwright/test';
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
      await audio.journalRecording(scope, id, 'original-crash-recording', 16000, [new Float32Array(8000).fill(.1)], 0, 8000);
      await audio.journalRecording(scope, id, 'original-crash-recording', 16000, [new Float32Array(8000).fill(.2)], 1, 16000);
      await audio.journalRecording(scope + '-different-project', id, 'other-recording', 16000, [new Float32Array(8000)], 0, 8000);
      let failed = false; try { await audio.journalRecording(scope, id, 'original-crash-recording', 16000, [new Float32Array(10)], 0, 10); } catch { failed = true; }
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
  } finally { await page.goto('about:blank'); await f.close(); }
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
  } finally { await page.goto('about:blank'); await f.close(); }
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
  } finally { await page.goto('about:blank'); await f.close(); }
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
  } finally { await page.goto('about:blank'); await f.close(); }
});
