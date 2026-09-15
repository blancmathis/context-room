import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { assistantFixture } from '../fixtures/assistant.mjs';
import { codexToolContent } from '../../src/assistant_observations.mjs';

const paneFor = page => page.getByRole('complementary', { name: 'Original document conversation' });
async function documentConversation(page, f) {
  await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
  await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
  await expect(paneFor(page)).toHaveAttribute('data-ready', 'true');
}
async function setDraft(page, text) {
  await page.evaluate(text => { const editor = document.getElementById('docEditor'); editor.value = text; editor.dispatchEvent(new Event('input', { bubbles: true })); }, text);
}

test('@smoke @assistant live draft sharing is opt-in, stays in its original document and stops on reload', async ({ page }, testInfo) => {
  const f = await assistantFixture(), original = fs.readFileSync(path.join(f.root, 'docs/Original.md'), 'utf8');
  const frames = []; page.on('request', request => { if (request.url().endsWith('/observation/frame')) frames.push(request.postDataJSON()); });
  try {
    await documentConversation(page, f); const pane = paneFor(page);
    await expect(pane).toHaveAttribute('data-observation', 'off'); expect(frames).toHaveLength(0); expect(f.connections()).toBe(0);
    await pane.getByRole('button', { name: 'Share live source', exact: true }).click();
    await expect(pane).toHaveAttribute('data-observation', 'live');
    const draft = original + '\nUnfinished human draft visible only through explicit observation.';
    await setDraft(page, draft); await expect.poll(() => frames.at(-1)?.frame.text).toBe(draft);
    await pane.getByRole('textbox').fill('Read my explicitly shared draft.'); await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(1);
    const read = await f.turns[0].tool('context_room_document', { action: 'read' }, { signal: new AbortController().signal });
    expect(read.content).toBe(original); expect(read.observation.text).toBe(draft); expect(read.observation.accepted).toBe(false);
    expect(fs.readFileSync(path.join(f.root, 'docs/Original.md'), 'utf8')).toBe(original);
    await expect(pane.locator('.assistant-observation')).toContainText('last read by Codex');
    await pane.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(pane.getByRole('button', { name: 'Stop sharing source', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('live-original-draft.png') });
    await setDraft(page, original); await page.evaluate(() => selectFile('docs/Other.md'));
    await expect(pane).toHaveAttribute('data-observation', 'paused');
    const away = await f.turns[0].tool('context_room_document', { action: 'read' }, { signal: new AbortController().signal });
    expect(away.observation.state).toBe('paused'); expect(away.observation.text).toBeUndefined(); expect(away.content).toBe(original);
    await pane.getByRole('button', { name: 'Stop sharing source', exact: true }).click(); await expect(pane).toHaveAttribute('data-observation', 'off');
    f.finish(); await page.reload(); await documentConversation(page, f); await expect(paneFor(page)).toHaveAttribute('data-observation', 'off');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant notebook observation includes the unfinished visible shape without committing it', async ({ page }, testInfo) => {
  const f = await assistantFixture(); const frames = [];
  page.on('request', request => { if (request.url().endsWith('/observation/frame')) frames.push(request.postDataJSON()); });
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(async () => { window.notebookUnderTest = await openContextRoomNotebook('docs/Observed.crnb'); });
    const notebook = page.getByRole('dialog', { name: 'Notebook: docs/Observed.crnb', exact: true });
    await expect(notebook).toHaveAttribute('data-save-state', 'confirmed'); await notebook.getByRole('button', { name: 'Ask about selection', exact: true }).click();
    const pane = paneFor(page); await expect(pane).toHaveAttribute('data-ready', 'true');
    await pane.getByRole('button', { name: 'Share live source', exact: true }).click(); await expect(pane).toHaveAttribute('data-observation', 'live');
    const blank = frames.at(-1).frame.image;
    await pane.getByRole('textbox').fill('Look at my unfinished shape.'); await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(1); await pane.getByRole('button', { name: 'Minimize conversation' }).click();
    await expect(pane.getByRole('button', { name: 'Stop sharing source', exact: true })).toBeInViewport();
    await notebook.getByRole('button', { name: 'Ellipse', exact: true }).click();
    const box = await notebook.locator('canvas').boundingBox();
    await page.mouse.move(box.x + 25, box.y + 65); await page.mouse.down(); await page.mouse.move(box.x + 95, box.y + 115, { steps: 12 });
    await expect.poll(() => frames.at(-1)?.frame.image).not.toBe(blank);
    const result = await f.turns[0].tool('context_room_notebook', { action: 'scene' }, { signal: new AbortController().signal, callId: 'observe', turnId: f.turns[0].turnId });
    expect(result.document.objects).toHaveLength(0); expect(result.observation.state).toBe('live'); expect(result.observation.accepted).toBe(false);
    const content = codexToolContent(result); expect(content).toHaveLength(2); expect(content[1].type).toBe('inputImage'); expect(content[1].imageUrl).not.toBe(blank);
    expect(await page.evaluate(() => Boolean(notebookUnderTest.surface.gesture))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('live-unfinished-notebook.png') }); await page.mouse.up();
    await expect(notebook).toHaveAttribute('data-save-state', 'confirmed');
    await notebook.getByRole('button', { name: 'Close notebook', exact: true }).click();
    await expect(pane).toHaveAttribute('data-observation', 'off'); f.finish();
    expect(fs.existsSync(path.join(f.root, 'docs/Observed.crnb'))).toBe(false);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke @assistant replacing another live source surface requires its explicit current takeover', async ({ page, context }) => {
  const f = await assistantFixture(); let second;
  try {
    await documentConversation(page, f); await paneFor(page).getByRole('button', { name: 'Share live source', exact: true }).click();
    await expect(paneFor(page)).toHaveAttribute('data-observation', 'live');
    second = await context.newPage(); await documentConversation(second, f);
    await expect(paneFor(second)).toHaveAttribute('data-observation', 'elsewhere');
    await paneFor(second).getByRole('button', { name: 'Take over source sharing', exact: true }).click();
    await expect(paneFor(second)).toHaveAttribute('data-observation', 'live');
    await expect(paneFor(page)).toHaveAttribute('data-observation', 'off');
    await paneFor(second).getByRole('button', { name: 'Stop sharing source', exact: true }).click();
    await expect(paneFor(second)).toHaveAttribute('data-observation', 'off'); expect(f.connections()).toBe(0);
  } finally { try { await second?.close(); if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});
