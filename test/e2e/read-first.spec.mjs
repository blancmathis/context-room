import fs from 'node:fs';
import path from 'node:path';
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

test('@smoke the reader reaches any section in one click and never writes the document', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const filler = Array.from({ length: 60 }, (_, index) => `Line ${index + 1} of filler text.`).join('\n\n');
    const guide = ['---', 'title: Guide', 'status: draft', '---', '# Guide', '', 'Jump to [the second part](#second-part) or [the other document](Other.md#other-document).', '',
      '## Setup', filler, '## Second part', filler, '## Setup', 'Repeated heading.', filler, ''].join('\n');
    const big = Array.from({ length: 60 }, (_, part) => `## Part ${part + 1}\n\n${Array.from({ length: 50 }, (_, line) => `Part ${part + 1} line ${line + 1}.`).join('\n')}`).join('\n\n') + '\n';
    const files = { guide: path.join(f.root, 'docs/Guide.md'), other: path.join(f.root, 'docs/Other.md'), big: path.join(f.root, 'docs/Big.md') };
    fs.writeFileSync(files.guide, guide);
    fs.writeFileSync(files.big, big);
    const before = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs]]));
    const writes = [];
    page.on('request', (request) => { if (request.method() !== 'GET' && /\/api\/file/.test(request.url())) writes.push(request.method() + ' ' + request.url()); });

    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Guide.md'));
    const reader = page.locator('#docReader');
    await expect(reader.locator('details.markdown-frontmatter')).not.toHaveAttribute('open', /.*/);
    await expect(reader.locator('details.markdown-frontmatter summary')).toHaveText('Front matter 2 fields');
    const toc = reader.locator('nav.doc-toc details');
    if (!(await toc.evaluate((details) => details.open))) await toc.locator('summary').click();
    await expect(toc.locator('a')).toHaveText(['Setup', 'Second part', 'Setup']);
    await toc.locator('a').nth(2).click();
    const repeated = reader.locator('[data-heading-id="setup-1"]');
    await expect(repeated).toBeInViewport();
    await expect(repeated).toBeFocused();

    await reader.getByRole('link', { name: 'the second part' }).click();
    await expect(reader.locator('[data-heading-id="second-part"]')).toBeInViewport();

    await reader.getByRole('link', { name: 'the other document' }).click();
    await expect.poll(() => page.evaluate(() => state.selected)).toBe('docs/Other.md');
    await expect(page.locator('#docReader [data-heading-id="other-document"]')).toBeFocused();

    await page.evaluate(() => selectFile('docs/Big.md'));
    await expect(page.locator('#docReader .markdown-section')).toHaveCount(60);
    await expect(page.locator('#viewer .plain-text-view')).toHaveCount(0);
    const bigToc = page.locator('#docReader nav.doc-toc details');
    if (!(await bigToc.evaluate((details) => details.open))) await bigToc.locator('summary').click();
    await bigToc.getByRole('link', { name: 'Part 40', exact: true }).click();
    await expect(page.locator('#docReader [data-heading-id="part-40"]')).toBeInViewport();
    expect(await page.locator('#docReader [data-line-index]').last().getAttribute('data-line-index')).toBe(String(big.split('\n').length - 1));

    for (const [key, file] of Object.entries(files)) expect([fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs], key).toEqual(before[key]);
    expect(writes).toEqual([]);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});
