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
