import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { assistantFixture } from '../fixtures/assistant.mjs';
import { legacyConversationSnapshot } from '../fixtures/lisiere-conversations.mjs';
import { migrateLisiereConversation } from '../../src/context_room.mjs';

test('@smoke retained Lisière history exports exactly and continues only in an explicitly started scoped task', async ({ page }, testInfo) => {
  const f = await assistantFixture(), errors = []; page.on('pageerror', failure => errors.push(failure.message));
  try {
    const legacy = await legacyConversationSnapshot(f.base, { desktop: true, extraMessages: 60, longText: 'Long original passage. '.repeat(800), extraRecordBytes: 1100000 });
    const options = { snapshot: legacy.snapshot, selector: legacy.selector, path: 'docs/Original.md' }, authority = { storageRoot: path.join(f.base, 'private-assistant') };
    const preview = migrateLisiereConversation(f.root, options, authority);
    const applied = migrateLisiereConversation(f.root, { ...options, apply: true, expectedRevision: preview.revision }, authority);
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }), retained = pane.getByRole('region', { name: 'Recovered Lisière history' });
    await expect(pane.getByLabel('Saved conversations for this original source')).toHaveValue(applied.conversationId);
    await expect(retained).toContainText('Sending or Voice starts a new task for docs/Original.md.');
    await retained.locator('summary').filter({ hasText: /^Read retained messages/ }).click();
    await expect(retained).toContainText('Original human question 🖊️');
    await retained.getByRole('button', { name: 'Read more of this retained message' }).click();
    await expect(retained.getByRole('button', { name: 'Read more of this retained message' })).toBeHidden();
    const more = retained.getByRole('button', { name: 'Load more retained messages', includeHidden: true });
    for (let i = 0; i < 5 && await more.isVisible(); i++) { await more.click(); await expect(more).toBeEnabled(); }
    await expect(more).toBeHidden(); await expect(retained).toContainText('Retained additional question 59'); await expect(retained).toContainText('Delivery unconfirmed · never replayed');
    const pending = page.waitForEvent('download'); await retained.getByRole('button', { name: 'Export original history' }).click(); const download = await pending;
    const exportedPath = testInfo.outputPath('retained-original.json'); await download.saveAs(exportedPath);
    const binding = JSON.parse(fs.readFileSync(path.join(authority.storageRoot, 'conversations', applied.conversationId + '.json')));
    expect(fs.readFileSync(exportedPath).equals(fs.readFileSync(path.join(authority.storageRoot, 'legacy-history', binding.legacy.hash + '.json')))).toBe(true);
    // A synthetic save-dialog cancellation must not be reported as a saved export.
    await page.evaluate(() => { window.ContextRoomNativeOwner = { saveFile: async () => ({ saved: false }) }; });
    try { await retained.getByRole('button', { name: 'Export original history' }).click(); await expect(retained).toContainText('Export cancelled. Original history remains available.'); }
    finally { await page.evaluate(() => { delete window.ContextRoomNativeOwner; }); }
    expect(f.connections()).toBe(0); expect(f.turns).toHaveLength(0);
    await retained.locator('summary').filter({ hasText: /^Read retained messages/ }).click();
    await page.evaluate(() => selectFile('docs/Other.md')); await expect(pane).toContainText('docs/Original.md');
    await pane.getByRole('textbox').fill('Continue here with my new explicit question.'); await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(1); expect(f.starts).toHaveLength(1); expect(f.resumes).toHaveLength(0);
    expect(f.turns[0].threadId).not.toBe('retained-task-original');
    const history = await f.turns[0].tool('context_room_history', {}, { signal: new AbortController().signal }); expect(history.legacy.originalThreadId).toBe('retained-task-original');
    expect(history.messages[0].text).toBe('Original human question 🖊️');
    f.finish('New scoped continuation confirmed.'); await expect(pane).toContainText('New scoped continuation confirmed.');
    await expect(retained).toContainText('Continuation in a separate Context Room task.');
    const accessibility = await new AxeBuilder({ page }).include('.assistant-panel').analyze(); expect(accessibility.violations).toEqual([]); expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('retained-conversation-continuation.png') });
    await page.reload(); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Original document conversation' })).toContainText('New scoped continuation confirmed.');
    expect(f.starts).toHaveLength(1); expect(f.turns).toHaveLength(1);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});
