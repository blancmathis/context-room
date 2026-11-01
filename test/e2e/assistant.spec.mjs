import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { assistantFixture, MAC_TASK_ID } from '../fixtures/assistant.mjs';
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

test('@smoke @assistant older original-source history remains reachable beyond other files and preserves its selected unsent draft', async ({ page }, testInfo) => {
  const f = await assistantFixture();
  try {
    const templates = [];
    for (const rel of ['docs/Other.md', 'docs/Original.md']) {
      const created = await f.post('/api/assistant/conversations', { requestId: crypto.randomUUID(), source: { kind: 'document', path: rel } });
      expect(created.status).toBe(201);
      const file = path.join(f.base, 'private-assistant/conversations', created.body.id + '.json');
      templates.push(JSON.parse(fs.readFileSync(file))); fs.unlinkSync(file);
    }
    let originalId;
    for (let i = 0; i < 572; i++) {
      const other = i < 501, saved = structuredClone(templates[other ? 0 : 1]);
      saved.id = `${other ? '00000000' : 'ffffffff'}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
      saved.origin.sessionId = saved.id; saved.updatedAt = new Date(Date.UTC(2024, 0, 1) + i).toISOString();
      if (i === 501) originalId = saved.id;
      else if (!other) saved.origin.source.selection = { start: 0, end: 1, text: '#' };
      fs.writeFileSync(path.join(f.base, 'private-assistant/conversations', saved.id + '.json'), JSON.stringify(saved), { mode: 0o600 });
    }
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' });
    const history = pane.getByLabel('Saved conversations for this original source'), older = pane.getByRole('button', { name: 'Load older conversations' });
    await expect(history).toHaveValue(originalId); await expect(history.locator('option')).toHaveCount(51);
    await pane.getByRole('textbox').fill('Keep my unsent text while I inspect older conversations.');
    const configured = await f.post('/api/assistant/conversations/' + originalId + '/configure', { model: 'gpt-6-astra', effort: 'high' }); expect(configured.status).toBe(200);
    await older.click(); await expect(pane).toContainText('Saved conversations changed. Refresh history');
    await expect(history).toHaveValue(originalId); await expect(pane.getByRole('textbox')).toHaveValue('Keep my unsent text while I inspect older conversations.');
    await pane.getByRole('button', { name: 'Refresh history' }).click(); await expect(older).toBeVisible(); await older.click();
    await expect(history.locator('option')).toHaveCount(71); await expect(older).toBeHidden(); await expect(history).toHaveValue(originalId);
    await expect(pane.getByRole('textbox')).toHaveValue('Keep my unsent text while I inspect older conversations.');
    expect(fs.readdirSync(path.join(f.base, 'private-assistant/conversations')).filter(name => name.endsWith('.json'))).toHaveLength(572);
    expect(f.connections()).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('retained-history-pages.png') });
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

test('@assistant lists Mac Codex tasks read-only and opens one on the Mac', async ({ page }) => {
  const f = await assistantFixture({ platform: 'darwin' }), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md'));
    await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }); await expect(pane).toBeVisible();
    await pane.getByRole('button', { name: 'Codex tasks on this Mac', exact: true }).click();
    const first = pane.getByRole('button', { name: /Read summary: Plan the <b>import<\/b>/ }); await expect(first).toBeVisible();
    await expect(pane.locator('.assistant-mac-list b')).toHaveCount(0); // a title is text, never markup
    await expect(pane.getByRole('button', { name: 'Next tasks', exact: true })).toBeVisible();
    await first.click();
    const detail = pane.locator('.assistant-mac-detail');
    await expect(detail).toContainText('Summary \u00b7 read only'); await expect(detail).toContainText('Import my projects'); await expect(detail).toContainText('Done: 4 projects.');
    await expect(pane.getByRole('button', { name: /continue/i })).toHaveCount(0);
    await detail.getByRole('button', { name: 'Show on Mac', exact: true }).click();
    await expect.poll(() => f.opened).toEqual(['codex://threads/' + MAC_TASK_ID]);
    await detail.getByRole('button', { name: 'Back to tasks', exact: true }).click(); await expect(first).toBeVisible();
    expect(f.turns.length).toBe(0); expect(f.starts.length).toBe(0); expect(errors).toEqual([]);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant follow agent frames a far agent edit and a human gesture stops it', async ({ page }) => {
  const f = await assistantFixture();
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(async () => { window.notebookUnderTest = await openContextRoomNotebook('docs/Sketch.crnb'); });
    const notebook = page.getByRole('dialog', { name: 'Notebook: docs/Sketch.crnb', exact: true });
    await expect(notebook).toHaveAttribute('data-save-state', 'confirmed');
    await notebook.getByRole('button', { name: 'Ask about selection', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' });
    const follow = notebook.getByRole('button', { name: 'Follow agent', exact: true });
    await expect(follow).toHaveAttribute('aria-pressed', 'false'); await follow.dispatchEvent('click'); await expect(follow).toHaveAttribute('aria-pressed', 'true');
    await pane.getByRole('textbox').fill('Draw far to the right.'); await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(1); const turn = f.turns[0];
    const put = (id, x) => turn.tool('context_room_notebook', { action: 'edit', edits: [{ kind: 'put', id, expectedRevision: 0, object: { type: 'rect', x, y: 100, width: 180, height: 130 } }] }, { callId: id, turnId: turn.turnId, signal: new AbortController().signal });
    await put('far-box', 5000);
    await expect.poll(() => page.evaluate(() => { const [x, , width] = notebookUnderTest.surface.viewportBounds(); return x <= 5000 && 5180 <= x + width; })).toBe(true);
    // On a phone the conversation pane covers the whole canvas: minimize it, then drag where the canvas is the top element.
    const freePoint = () => page.locator('canvas.notebook-canvas').evaluate((canvas) => {
      const box = canvas.getBoundingClientRect();
      for (let y = box.top + 20; y < box.bottom - 60; y += 20) for (let x = box.left + 20; x < box.right - 100; x += 20) if (document.elementFromPoint(x, y) === canvas && document.elementFromPoint(x + 80, y + 40) === canvas) return { x, y };
      return null;
    });
    if (!(await freePoint())) await pane.getByRole('button', { name: 'Minimize conversation', exact: true }).click();
    await expect.poll(freePoint).not.toBeNull();
    const from = await freePoint();
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + 80, from.y + 40, { steps: 4 }); await page.mouse.up();
    await expect(follow).toHaveAttribute('aria-pressed', 'false'); await expect(notebook).toContainText('You took back the view.');
    // Minimizing the pane resizes the canvas: wait for the view to settle before freezing it.
    let held, settled = 0;
    await expect.poll(async () => { const now = await page.evaluate(() => notebookUnderTest.surface.viewportBounds()); settled = held && JSON.stringify(held) === JSON.stringify(now) ? settled + 1 : 0; held = now; return settled; }, { intervals: [150] }).toBeGreaterThanOrEqual(3);
    await put('farther-box', 9000);
    await expect.poll(() => page.evaluate(() => notebookUnderTest.surface.document.objects.some(object => object.id === 'farther-box'))).toBe(true);
    expect(await page.evaluate(() => notebookUnderTest.surface.viewportBounds())).toEqual(held);
    f.finish('Done.');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant Fast checkbox follows the model catalogue and reaches turn/start', async ({ page }) => {
  const f = await assistantFixture();
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' });
    await pane.locator('summary').filter({ hasText: 'Codex model' }).click(); await pane.getByRole('button', { name: 'Load available models' }).click();
    const fast = pane.getByLabel('Conversation Fast mode'), models = pane.getByLabel('Conversation Codex model');
    await expect(models).toContainText('Synthetic plain model'); await expect(fast).toBeEnabled(); await expect(fast).not.toBeChecked();
    await fast.check(); await expect(fast).toBeChecked();
    await models.selectOption('synthetic-plain'); await expect(fast).toBeDisabled(); await expect(fast).not.toBeChecked(); await expect(pane).toContainText('Fast was on but is not offered for this model now.');
    await models.selectOption('gpt-6-astra'); await expect(fast).toBeEnabled(); await fast.check(); await expect(fast).toBeChecked();
    await pane.getByRole('textbox').fill('Answer quickly.'); await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(1); expect(f.turns[0].fast).toBe(true); f.finish();
    await expect(pane).toHaveAttribute('data-operation-status', 'completed');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant a failed Fast re-sync before Send sends nothing, keeps the text and lets the text change', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const { pane, box, send } = await staleFastPane(page, f);
    const failing = route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic configure failure.' }) });
    await page.route('**/configure', failing);
    await box.fill('First text.'); await send.click();
    await expect(send).toBeEnabled(); await expect(box).toHaveValue('First text.'); expect(f.turns.length).toBe(0);
    await page.unroute('**/configure', failing);
    await box.fill('Changed text.'); await send.click();
    await expect.poll(() => f.turns.length).toBe(1); f.finish();
    await expect(pane).toHaveAttribute('data-operation-status', 'completed');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant a delayed failing Fast re-sync keeps Send inactive, sends once and leaves no request id', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const { pane, box, send } = await staleFastPane(page, f);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const failing = async route => { await gate; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic configure failure.' }) }); };
    await page.route('**/configure', failing);
    await box.fill('First text.'); await send.click();
    await expect(send).toBeDisabled();
    await send.click({ force: true }); await box.press('Enter'); await box.fill('Changed text.');
    await page.waitForTimeout(600); await expect(send).toBeDisabled();
    release(); await expect(send).toBeEnabled(); await expect(box).toHaveValue('Changed text.'); expect(f.turns.length).toBe(0);
    await page.unroute('**/configure', failing);
    await send.click();
    await expect.poll(() => f.turns.length).toBe(1); f.finish();
    await expect(pane).not.toContainText('The previous send is unconfirmed');
    await expect(pane).toHaveAttribute('data-operation-status', 'completed');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

async function staleFastPane(page, f) {
  await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
  await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Original document conversation' });
  await pane.locator('summary').filter({ hasText: 'Codex model' }).click(); await pane.getByRole('button', { name: 'Load available models' }).click();
  const fast = pane.getByLabel('Conversation Fast mode'), models = pane.getByLabel('Conversation Codex model');
  await expect(models).toContainText('Synthetic plain model'); await fast.check(); await expect(fast).toBeChecked();
  // The server keeps Fast on for a model that does not offer it: the state that makes Send configure first.
  // The server itself stores it, not one faked response: the 500 ms poll replaces the conversation with the server's copy.
  // Unroute only once the request has passed: a request still in flight would reach the server unchanged.
  let stored; const passed = new Promise(resolve => { stored = resolve; });
  const stale = async route => { await route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), fast: true }) }); stored(); };
  await page.route('**/configure', stale);
  await models.selectOption('synthetic-plain'); await expect(fast).toBeDisabled(); await passed; await page.unroute('**/configure', stale);
  return { pane, box: pane.getByRole('textbox'), send: pane.getByRole('button', { name: 'Send', exact: true }) };
}

test('@assistant the history and New conversation stay inactive while Send re-syncs Fast', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const { pane, box, send } = await staleFastPane(page, f);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const slow = async route => { await gate; await route.continue(); };
    await page.route('**/configure', slow);
    const saved = pane.getByLabel('Saved conversations for this original source'), fresh = pane.getByRole('button', { name: 'New conversation', exact: true });
    await expect(saved).toBeEnabled(); await expect(fresh).toBeEnabled();
    await box.fill('Held text.'); await send.click();
    await expect(send).toBeDisabled(); await expect(saved).toBeDisabled(); await expect(fresh).toBeDisabled();
    release(); await expect.poll(() => f.turns.length).toBe(1); f.finish();
    await expect(pane).toHaveAttribute('data-operation-status', 'completed');
    await expect(saved).toBeEnabled(); await expect(fresh).toBeEnabled();
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant a configure that never answers ends in an error after the timeout, keeps the text and lets Send work', async ({ page }) => {
  const f = await assistantFixture();
  try {
    await page.clock.install();
    const { pane, box, send } = await staleFastPane(page, f);
    const silent = async () => {};
    await page.route('**/configure', silent);
    await box.fill('Kept text.'); await send.click(); await expect(send).toBeDisabled();
    await page.clock.fastForward(20_000); await expect(send).toBeDisabled();
    await page.clock.fastForward(30_000);
    await expect(send).toBeEnabled(); await expect(box).toHaveValue('Kept text.'); await expect(pane).toContainText('Press Send again'); expect(f.turns.length).toBe(0);
    await page.unroute('**/configure', silent);
    await send.click();
    await expect.poll(() => f.turns.length).toBe(1); f.finish();
    await expect(pane).not.toContainText('The previous send is unconfirmed');
    await expect(pane).toHaveAttribute('data-operation-status', 'completed');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant a send that never answers ends in an error after the timeout and the second Send replays the same request id', async ({ page }) => {
  const f = await assistantFixture();
  try {
    await page.clock.install();
    const { pane, box, send } = await staleFastPane(page, f);
    const ids = []; page.on('request', request => { if (request.url().endsWith('/send')) ids.push(request.postDataJSON().requestId); });
    const silent = async () => {};
    await page.route('**/send', silent);
    await box.fill('Kept text.'); await send.click(); await expect(send).toBeDisabled();
    await expect.poll(() => ids.length).toBe(1);
    await page.clock.fastForward(20_000); await expect(send).toBeDisabled();
    await page.clock.fastForward(30_000);
    await expect(send).toBeEnabled(); await expect(box).toHaveValue('Kept text.'); await expect(pane).toContainText('Press Send again');
    await page.unroute('**/send', silent);
    await send.click();
    await expect.poll(() => f.turns.length).toBe(1); f.finish();
    expect(ids.length).toBe(2); expect(ids[1]).toBe(ids[0]);
    await expect(pane).toHaveAttribute('data-operation-status', 'completed'); expect(f.turns.length).toBe(1);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant a model change whose re-sync never answers ends in a plain timeout error, not the Send one', async ({ page }) => {
  const f = await assistantFixture();
  try {
    await page.clock.install();
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' });
    await pane.locator('summary').filter({ hasText: 'Codex model' }).click(); await pane.getByRole('button', { name: 'Load available models' }).click();
    const models = pane.getByLabel('Conversation Codex model');
    await expect(models).toContainText('Synthetic plain model');
    let configures = 0; const silent = async () => { configures += 1; };
    await page.route('**/configure', silent);
    await models.selectOption('synthetic-plain'); await expect.poll(() => configures).toBe(1);
    await page.clock.fastForward(50_000);
    await expect(pane).toContainText('The Mac did not answer in time. Try again.'); await expect(pane).not.toContainText('Press Send again');
    await page.unroute('**/configure', silent);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant Send does nothing while the conversation changes and no text leaves for the conversation being left', async ({ page }) => {
  const f = await assistantFixture();
  try {
    for (let i = 0; i < 2; i++) expect((await f.post('/api/assistant/conversations', { requestId: crypto.randomUUID(), source: { kind: 'document', path: 'docs/Original.md' } })).status).toBe(201);
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }), saved = pane.getByLabel('Saved conversations for this original source');
    const send = pane.getByRole('button', { name: 'Send', exact: true }), box = pane.getByRole('textbox');
    await expect(saved.locator('option')).toHaveCount(2); await expect(send).toBeEnabled();
    const leftId = await saved.inputValue(), nextId = await saved.locator('option').evaluateAll((options, left) => options.map(option => option.value).find(value => value !== left), leftId);
    let release, sends = 0, reads = 0; const gate = new Promise(resolve => { release = resolve; });
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/send')) sends += 1; });
    await page.route(new RegExp('/api/assistant/conversations/' + nextId + '$'), async route => { reads += 1; await gate; await route.continue(); });
    await box.fill('Text for the conversation I am leaving.');
    await saved.selectOption(nextId); await expect.poll(() => reads).toBe(1);
    await expect(send).toBeDisabled();
    await box.evaluate(textbox => { textbox.form.requestSubmit(); });
    await page.waitForTimeout(300); expect(sends).toBe(0); expect(f.turns).toHaveLength(0);
    release();
    await expect(saved).toHaveValue(nextId); await expect(saved).toBeEnabled(); await expect(send).toBeEnabled();
    expect(sends).toBe(0); expect(f.turns).toHaveLength(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant on a touch tablet, Discuss keeps the keyboard closed and the keyboard never hides the history controls', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Touch emulation with a coarse pointer is checked in Chromium.');
  const f = await assistantFixture();
  // BOOX/Android tablet in landscape: 1280×800 CSS px, touch first.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).tap();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }); await expect(pane).toBeVisible();
    const textbox = pane.getByRole('textbox', { name: 'Message to the original document agent' });
    await expect(textbox).toBeVisible(); await expect(textbox).not.toBeFocused();
    // Android resizes the WebView when the keyboard opens: 408 CSS px are left on the 2560×1600 tablet.
    await page.setViewportSize({ width: 1280, height: 408 }); await textbox.tap(); await expect(textbox).toBeFocused();
    const reachable = locator => locator.evaluate(element => {
      const box = element.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y), panel = element.closest('.assistant-panel').getBoundingClientRect();
      return box.top >= Math.max(0, panel.top) && box.bottom <= Math.min(innerHeight, panel.bottom) && Boolean(hit) && (hit === element || element.contains(hit));
    });
    for (const control of [pane.getByRole('button', { name: 'New conversation' }), pane.getByRole('button', { name: 'Refresh history' }), pane.getByLabel('Saved conversations for this original source'), textbox])
      await expect.poll(() => reachable(control), { message: await control.evaluate(element => element.getAttribute('aria-label') || element.textContent) }).toBe(true);
  } finally { await context.close(); await f.close(); }
});
