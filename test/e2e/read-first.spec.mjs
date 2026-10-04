import { test, expect } from '@playwright/test';
import { assistantFixture } from '../fixtures/assistant.mjs';

test('@smoke a Markdown document opens for reading, and Edit opens the editor', async ({ page }) => {
  const f = await assistantFixture();
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md'));
    await expect(page.locator('#docReader')).toBeVisible();
    await expect(page.locator('#viewer textarea, #viewer [contenteditable="true"], #viewer input:not([type])')).toHaveCount(0);
    await expect(page.locator('[data-file-save]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('#docEditor');
    await expect(editor).toBeFocused();
    await editor.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
    await editor.pressSequentially('Read first.');
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
    await page.locator('[data-file-save]').click();
    await expect(page.locator('[data-file-save]')).toBeDisabled();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('#docReader')).toContainText('Read first.');
    await expect(page.locator('#docEditor')).toHaveCount(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});
