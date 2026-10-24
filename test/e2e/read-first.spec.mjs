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

test('@smoke the Documents map follows the accepted index and pages through it', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const { writeDocReviewDecision } = await import('../../src/context_room.mjs');
    fs.writeFileSync(path.join(f.root, 'docs/index.md'), '# Docs\n\n1. [Original](Original.md)\n2. [Other](Other.md#other-document)\n');
    fs.writeFileSync(path.join(f.root, 'docs/Notes.md'), '# Loose notes\n\nNot linked from the index.\n');
    for (const rel of ['docs/index.md', 'docs/Notes.md', 'docs/Original.md', 'docs/Other.md']) writeDocReviewDecision(f.root, rel, { status: 'verified' });

    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    const map = page.locator('#documentsMapPanel');
    await expect(map).toBeVisible();
    await expect(page.locator('#documentsMapSource')).toHaveText('In the order of docs/index.md');
    await expect(map.locator('[data-docs-map-role="Reference"] [data-docs-map-path]')).toHaveText([/Docs/, /Original document/, /Other document/]);
    await expect(map.locator('[data-docs-map-role="Unfiled"] [data-docs-map-path]')).toHaveText([/Loose notes/]);

    await map.locator('[data-docs-map-path="docs/Other.md"]').click();
    await expect.poll(() => page.evaluate(() => state.selected)).toBe('docs/Other.md');
    const pager = page.locator('#docReader nav.doc-pager');
    await expect(pager.locator('.doc-pager-link')).toHaveText([/Previous\s*Original document/]);
    await pager.getByRole('button', { name: /Previous/ }).click();
    await expect.poll(() => page.evaluate(() => state.selected)).toBe('docs/Original.md');
    await expect(page.locator('#docReader nav.doc-pager .doc-pager-link')).toHaveText([/Previous\s*Docs/, /Next\s*Other document/]);

    await page.evaluate(() => selectFile('docs/Notes.md'));
    await expect(page.locator('#docReader nav.doc-pager')).toHaveText('Unfiled: docs/index.md does not link this document.');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

const openTextSize = async (page) => { await page.getByRole('button', { name: 'Text size', exact: true }).click(); return page.getByRole('dialog', { name: 'Text size' }); };

test('@smoke a 20001-heading document pages its Contents and finds headings without accents', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const file = path.join(f.root, 'docs/Index.md');
    fs.writeFileSync(file, '# Index\n\n' + Array.from({ length: 20001 }, (_, index) => `### Résumé ${index + 1}`).join('\n') + '\n');
    const before = [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs];
    const writes = [];
    page.on('request', (request) => { if (request.method() !== 'GET' && /\/api\/file/.test(request.url())) writes.push(request.method() + ' ' + request.url()); });
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Index.md'));
    const toc = page.locator('#docReader nav.doc-toc');
    if (!(await toc.locator('details').evaluate((details) => details.open))) await toc.locator('summary').click();
    await expect(toc.locator('[data-toc-count]')).toHaveText('1–40 of 20,001');
    await expect(toc.locator('[data-toc-list] a')).toHaveCount(40);
    await toc.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(toc.locator('[data-toc-count]')).toHaveText('41–80 of 20,001');
    await toc.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect(toc.locator('[data-toc-count]')).toHaveText('1–40 of 20,001');

    await page.evaluate(() => scrollToMarkdownAnchor('résumé-19999'));
    await expect(page.locator('#docReader [data-heading-id="résumé-19999"]')).toBeInViewport();
    await toc.locator('details').evaluate(async (details) => {
      details.open = false;
      await new Promise((resolve) => details.addEventListener('toggle', resolve, { once: true }));
      details.open = true;
    });
    await expect(toc.locator('[data-toc-count]')).toHaveText('19,961–20,000 of 20,001');

    await toc.getByRole('searchbox', { name: 'Search headings' }).fill('resume 19999');
    await expect(toc.locator('[data-toc-count]')).toHaveText('1–1 of 1');
    await page.evaluate(() => { document.querySelector('#docReader').scrollIntoView(); window.scrollTo(0, 0); });
    await toc.getByRole('link', { name: 'Résumé 19999', exact: true }).click();
    await expect(page.locator('#docReader [data-heading-id="résumé-19999"]')).toBeInViewport();
    await toc.getByRole('searchbox', { name: 'Search headings' }).fill('zzz');
    await expect(toc.locator('[data-toc-count]')).toHaveText('No heading matches');

    expect([fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs]).toEqual(before);
    expect(writes).toEqual([]);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke Aa changes the text size, keeps the reading place and survives a reload', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const big = Array.from({ length: 60 }, (_, part) => `## Part ${part + 1}\n\n${Array.from({ length: 50 }, (_, line) => `Part ${part + 1} line ${line + 1}.`).join('\n')}`).join('\n\n') + '\n';
    fs.writeFileSync(path.join(f.root, 'docs/Big.md'), big);
    fs.writeFileSync(path.join(f.root, 'docs/Notes.txt'), 'Plain notes.\n'.repeat(40));
    fs.writeFileSync(path.join(f.root, 'docs/Page.html'), '<!doctype html><html><body><h1>Visual page</h1><p>Own styles.</p></body></html>');
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));

    await page.evaluate(() => selectFile('docs/Big.md'));
    await expect(page.locator('#docReader')).toBeVisible();
    const sizeOf = () => page.locator('#docReader').evaluate((node) => getComputedStyle(node).fontSize);
    const standardSize = await sizeOf();
    await page.evaluate(() => scrollToMarkdownAnchor('part-30'));
    await expect(page.locator('#docReader [data-heading-id="part-30"]')).toBeInViewport();
    let dialog = await openTextSize(page);
    await dialog.getByRole('button', { name: '24', exact: true }).click();
    await expect.poll(sizeOf).toBe('24px');
    await expect(page.locator('#docReader [data-heading-id="part-30"]')).toBeInViewport();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    await page.reload(); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Big.md'));
    await expect.poll(sizeOf).toBe('24px');
    await page.evaluate(() => selectFile('docs/Notes.txt'));
    await expect(page.locator('#docReader.plain-text-view')).toBeVisible();
    expect(parseFloat(await sizeOf())).toBeCloseTo(20.8, 1);

    await page.evaluate(() => selectFile('docs/Page.html'));
    const frame = page.locator('iframe.html-preview-frame');
    await expect(frame.contentFrame().getByRole('heading', { name: 'Visual page' })).toBeVisible();
    await expect.poll(() => frame.evaluate((node) => node.contentDocument.documentElement.style.zoom || node.contentDocument.documentElement.style.fontSize)).toMatch(/^(1\.6|160%)$/);

    await page.evaluate(() => selectFile('docs/Big.md'));
    dialog = await openTextSize(page);
    await dialog.getByRole('button', { name: /^15 Standard$/ }).click();
    await expect.poll(sizeOf).toBe(standardSize);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('page buttons move one screen without smooth scrolling', async ({ page }, testInfo) => {
  const f = await assistantFixture();
  try {
    const big = Array.from({ length: 30 }, (_, part) => `## Part ${part + 1}\n\n${Array.from({ length: 40 }, (_, line) => `Part ${part + 1} line ${line + 1}.`).join('\n\n')}`).join('\n\n') + '\n';
    fs.writeFileSync(path.join(f.root, 'docs/Big.md'), big);
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Big.md'));
    await expect(page.locator('#docReader')).toBeVisible();
    const bar = page.locator('.reader-page-bar');
    if (testInfo.project.name.includes('mobile')) await expect(bar).toBeVisible();
    else {
      await expect(bar).toHaveCount(0);
      const dialog = await openTextSize(page);
      await dialog.getByRole('checkbox', { name: 'Page buttons' }).check();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(bar).toBeVisible();
    }
    const position = () => page.evaluate(() => { const target = activeDocumentScrollTarget(); return target.scrollTop; });
    const start = await position();
    await bar.getByRole('button', { name: 'Next page' }).click();
    const after = await page.evaluate(() => { const target = activeDocumentScrollTarget(); return { top: target.scrollTop, height: target === document.scrollingElement ? window.innerHeight : target.clientHeight, line: parseFloat(getComputedStyle(document.querySelector('#docReader')).lineHeight) }; });
    expect(after.top - start).toBeGreaterThan(after.height / 2);
    expect(Math.abs(after.top - start - (after.height - 2 * after.line))).toBeLessThanOrEqual(2);
    await bar.getByRole('button', { name: 'Previous page' }).click();
    expect(Math.abs((await position()) - start)).toBeLessThanOrEqual(2);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.locator('.reader-page-bar')).toHaveCount(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke the editor finds and replaces, and Replace all is one undo step', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const file = path.join(f.root, 'docs/Original.md');
    const before = fs.readFileSync(file, 'utf8');
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md'));
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('#docEditor');
    const original = '# Original document\n\nMémo one\nmemo two\nMEMO three\n';
    await editor.fill(original);
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    const bar = page.locator('.find-bar');
    await expect(bar).toBeVisible();
    await bar.getByRole('searchbox', { name: 'Find' }).fill('memo');
    await expect(bar.locator('[data-find-count]')).toHaveText('3 matches');
    await bar.getByRole('checkbox', { name: /Exact/ }).check();
    await expect(bar.locator('[data-find-count]')).toHaveText('1 match');
    await bar.getByRole('checkbox', { name: /Exact/ }).uncheck();
    await bar.getByRole('textbox', { name: 'Replace with' }).fill('note');
    await bar.getByRole('button', { name: 'Replace all', exact: true }).click();
    await expect(bar.locator('[data-find-count]')).toHaveText('Replaced 3 matches');
    await expect(editor).toHaveValue('# Original document\n\nnote one\nnote two\nnote three\n');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(editor).toHaveValue(original);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(editor).toHaveValue('# Original document\n\nnote one\nnote two\nnote three\n');
    await bar.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(bar).toBeHidden();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('searchbox', { name: 'Find' })).toBeFocused();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('explorer search matches accented names without accents', async ({ page }) => {
  const f = await assistantFixture();
  try {
    fs.writeFileSync(path.join(f.root, 'docs/Mémo.md'), '# Mémo\n\nAccented name.\n');
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    const explorerToggle = page.locator('#explorerOpen:visible, #sidebarToggle:visible').first();
    if (await page.locator('.app').evaluate((node) => node.classList.contains('sidebar-collapsed'))) await explorerToggle.click();
    await page.locator('#search').fill('memo');
    await expect(page.locator('#files [data-file-path="docs/Mémo.md"]')).toBeVisible();
    await expect(page.locator('#files [data-file-path="docs/Original.md"]')).toHaveCount(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});
