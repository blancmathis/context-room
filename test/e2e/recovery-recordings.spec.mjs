import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { assistantFixture } from '../fixtures/assistant.mjs';
import { recordingFixture } from '../fixtures/lisiere-recording.mjs';

test('@smoke @assistant @a11y explicit recording selection previews the source, attaches privately and never autoplays or sends', async ({ page }, testInfo) => {
  const f = await assistantFixture(), legacy = await recordingFixture(f.base), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md'));
    await page.getByRole('button', { name: 'Discuss', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }), section = pane.getByRole('region', { name: 'Recovered recordings' });
    await section.locator('summary').click(); await expect(section).toContainText('No recording has been explicitly attached');
    await section.getByRole('button', { name: 'Attach recovered recording', exact: true }).click();
    await section.getByLabel('Private recovery snapshot directory').fill(legacy.snapshot);
    await section.getByLabel('Original PCM filename').fill(legacy.name);
    await section.getByLabel('Recording label', { exact: true }).fill('Synthetic retained idea');
    await section.getByRole('button', { name: 'Preview recording link', exact: true }).click();
    await expect(section).toContainText('→ docs/Original.md');
    expect(fs.existsSync(path.join(f.base, 'private-assistant/legacy-recordings'))).toBe(false);
    await section.getByRole('button', { name: 'Attach this exact recording', exact: true }).click();
    await expect(section).toContainText('Recording attached to the original conversation');
    await section.getByRole('button', { name: 'Load audio for review', exact: true }).click();
    const audio = section.locator('audio'); await expect(audio).toBeVisible();
    expect(await audio.evaluate(node => ({ paused: node.paused, autoplay: node.autoplay }))).toEqual({ paused: true, autoplay: false });
    expect(f.turns).toEqual([]); expect(f.connections()).toBe(0);
    const a11y = await new AxeBuilder({ page }).include('.assistant-panel').analyze(); expect(a11y.violations).toEqual([]);
    // Private fixture paths and filenames are synthetic. Do not capture pairing credentials.
    await page.screenshot({ path: testInfo.outputPath('recording-association-review.png') });
    const saved = page.waitForEvent('download'); await section.getByRole('button', { name: 'Export original PCM', exact: true }).click();
    const download = await saved; expect(fs.readFileSync(await download.path())).toEqual(legacy.pcm);
    await pane.getByRole('button', { name: 'New conversation', exact: true }).click();
    await section.locator('summary').click(); await expect(section).toContainText('No recording has been explicitly attached');
    await expect(audio).toHaveCount(0); expect(errors).toEqual([]);
  } finally { try { if (!page.isClosed()) await page.close(); } finally { await f.close(); } }
});
