import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { assistantFixture } from '../fixtures/assistant.mjs';
import { writeDocReviewDecision } from '../../src/context_room.mjs';

// R2: a doc still in « To review » is not tap-editable, so tests that tap to edit accept their docs first.
const acceptDocs = (root, paths = ['docs/Original.md', 'docs/Other.md']) => { for (const rel of paths) writeDocReviewDecision(root, rel, { status: 'verified' }); };
// The open page may still hold the queue read before the decisions: refresh it until those docs left it.
const awaitAccepted = (page, paths = ['docs/Original.md']) => expect.poll(() => page.evaluate(async (paths) => {
  applyBackgroundReportPayload(await api('/api/reports'));
  return paths.filter((rel) => state.docqa?.queue?.some((item) => item.path === rel));
}, paths), { timeout: 15_000 }).toEqual([]);

// R2: no mode or Save button. A click puts the caret where it lands, the text saves itself, Escape shows the rendered doc.
test('@smoke a Markdown document opens for reading, and a click edits it where it lands', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const file = path.join(f.root, 'docs/Original.md');
    acceptDocs(f.root);
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await awaitAccepted(page);
    await page.evaluate(() => selectFile('docs/Original.md'));
    await expect(page.locator('#docReader')).toBeVisible();
    await expect(page.locator('#viewer textarea, #viewer [contenteditable="true"], #viewer input:not([type])')).toHaveCount(0);
    await expect(page.locator('[data-file-save], [data-file-mode]')).toHaveCount(0);
    for (const name of ['Edit', 'Done', 'Save']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);

    const box = await page.locator('#docReader .markdown-line', { hasText: 'Human original content.' }).evaluate((line) => {
      const range = document.createRange(), text = [...line.childNodes].find((node) => node.nodeType === 3 && node.data.includes('Human'));
      range.setStart(text, text.data.indexOf('Human')); range.setEnd(text, text.data.indexOf('Human') + 1);
      const rect = range.getBoundingClientRect(); return { x: rect.left, y: rect.top, height: rect.height };
    });
    await page.mouse.click(box.x + 1, box.y + box.height / 2);
    const editor = page.locator('#docEditor');
    await expect(editor).toBeFocused();
    expect(await editor.evaluate((node) => node.value.slice(node.selectionStart, node.selectionStart + 5))).toBe('Human');
    await editor.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
    await editor.pressSequentially('Read first.');
    await expect(page.locator('.file-panel .file-title')).toHaveClass(/unsaved/);
    await expect.poll(() => fs.readFileSync(file, 'utf8'), { timeout: 4_000 }).toContain('Read first.');
    await expect(page.locator('.file-panel .file-title')).not.toHaveClass(/unsaved/);
    await expect(editor).toBeFocused();
    await editor.press('Escape');
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

// R6: Find, Aa, the Git diff and Delete sit in the file bar's ⋯ menu.
const openMore = (page) => page.locator('.file-actions summary[aria-label="More"]').click();
const openTextSize = async (page) => { await openMore(page); await page.getByRole('button', { name: 'Text size', exact: true }).click(); return page.getByRole('dialog', { name: 'Text size' }); };

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

test('@smoke a 320-heading document: every Contents entry scrolls to its heading', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const file = path.join(f.root, 'docs/Index.md');
    fs.writeFileSync(file, '# Index\n\n' + Array.from({ length: 320 }, (_, index) => `## Section ${index + 1}\n\n` + 'A paragraph of body text that fills a line or two of the reading column.\n\n'.repeat(12)).join('') );
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Index.md'));
    const toc = page.locator('#docReader nav.doc-toc');
    if (!(await toc.locator('details').evaluate((details) => details.open))) await toc.locator('summary').click();
    // No wait for the Contents to finish drawing: a tap right after opening is the case that failed.
    for (const [pages, name] of [[0, 'Section 12'], [3, 'Section 130'], [4, 'Section 290']]) {
      for (let i = 0; i < pages; i += 1) await toc.getByRole('button', { name: 'Next', exact: true }).click();
      await page.evaluate(() => { document.querySelector('#docReader').scrollIntoView(); window.scrollTo(0, 0); });
      await toc.getByRole('link', { name, exact: true }).click();
      const heading = page.locator('#docReader [data-heading-id="' + name.toLowerCase().replace(' ', '-') + '"]');
      await expect(heading).toBeInViewport();
      // Off-screen sections have only an estimated height: the heading must still end at the top of the reading area.
      await expect.poll(() => heading.evaluate((node) => Math.round(node.getBoundingClientRect().top - (document.getElementById('docReader').getBoundingClientRect().top)))).toBeLessThan(200);
    }
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke a 320-heading HTML page: every Contents entry scrolls to its heading', async ({ page }) => {
  const f = await assistantFixture();
  try {
    fs.writeFileSync(path.join(f.root, 'docs/Long.html'), '<!doctype html><html><body>' + Array.from({ length: 320 }, (_, index) => `<h2>Part ${index + 1}</h2>` + '<p>Body line.</p>'.repeat(8)).join('') + '</body></html>');
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Long.html'));
    const frame = page.locator('iframe.html-preview-frame'); await expect(frame).toBeVisible();
    for (const [pages, name] of [[0, 'Part 12'], [3, 'Part 130'], [7, 'Part 320']]) {
      await page.getByRole('button', { name: 'Contents' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Contents' });
      for (let i = 0; i < pages; i += 1) await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      await dialog.getByRole('link', { name, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(frame.contentFrame().getByRole('heading', { name, exact: true })).toBeInViewport();
    }
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@smoke Aa changes the text size, keeps the reading place and survives a reload', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const big = Array.from({ length: 60 }, (_, part) => `## Part ${part + 1}\n\n${Array.from({ length: 50 }, (_, line) => `Part ${part + 1} line ${line + 1}.`).join('\n')}`).join('\n\n') + '\n';
    fs.writeFileSync(path.join(f.root, 'docs/Big.md'), big);
    acceptDocs(f.root, ['docs/Big.md']);
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
    await dialog.getByRole('button', { name: /^17 Standard$/ }).click();
    await expect.poll(sizeOf).toBe(standardSize);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('page buttons move one screen without smooth scrolling', async ({ page }, testInfo) => {
  const f = await assistantFixture();
  try {
    const big = Array.from({ length: 30 }, (_, part) => `## Part ${part + 1}\n\n${Array.from({ length: 40 }, (_, line) => `Part ${part + 1} line ${line + 1}.`).join('\n\n')}`).join('\n\n') + '\n';
    fs.writeFileSync(path.join(f.root, 'docs/Big.md'), big);
    acceptDocs(f.root, ['docs/Big.md']);
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await awaitAccepted(page, ['docs/Big.md']);
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
    await page.locator('#docReader .markdown-line', { hasText: 'Part 1 line 3.' }).first().click();
    await expect(page.locator('.reader-page-bar')).toHaveCount(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

// R6: a short bar. Discuss, ▾ (Dictate, Voice, Annotate) and ⋯ (Find, Aa, Git diff, Delete): one row at 820 px, 44 px on touch.
test('@smoke the file bar is one short row of 44 px targets on a touch tablet', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Touch emulation with a coarse pointer is checked in Chromium.');
  const f = await assistantFixture();
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    acceptDocs(f.root);
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await awaitAccepted(page);
    await page.evaluate(() => selectFile('docs/Original.md'));
    const bar = page.locator('.file-panel > header .file-actions');
    await expect(bar.getByRole('button', { name: 'Discuss', exact: true })).toBeEnabled();
    const shown = () => bar.evaluate((node) => [...node.querySelectorAll('button, summary')].filter((item) => item.checkVisibility()).map((item) => {
      const box = item.getBoundingClientRect();
      return { label: item.getAttribute('aria-label') || item.textContent, top: Math.round(box.top), width: box.width, height: box.height };
    }));
    const row = await shown();
    expect(row.map((item) => item.label)).toEqual(['Discuss', 'More ways to discuss', 'More']);
    expect(new Set(row.map((item) => item.top)).size).toBe(1);
    for (const item of row) expect(Math.min(item.width, item.height), item.label).toBeGreaterThanOrEqual(44);

    await bar.locator('summary[aria-label="More"]').tap();
    expect((await shown()).map((item) => item.label)).toEqual(['Discuss', 'More ways to discuss', 'More', 'Text size', 'Delete']);
    const remove = bar.getByRole('button', { name: 'Delete', exact: true });
    expect((await remove.boundingBox()).height).toBeGreaterThanOrEqual(44);
    // Opening the other menu closes this one.
    await bar.locator('summary[aria-label="More ways to discuss"]').tap();
    await expect(remove).toBeHidden();
    expect((await shown()).map((item) => item.label)).toEqual(['Discuss', 'More ways to discuss', 'Dictate', 'Voice', 'Annotate', 'More']);
    await page.locator('#docReader').tap({ position: { x: 4, y: 4 } });
    await expect(bar.getByRole('button', { name: 'Dictate', exact: true })).toBeHidden();
    expect(fs.existsSync(path.join(f.root, 'docs/Original.md'))).toBe(true);
  } finally { try { await context.close(); } finally { await f.close(); } }
});

test('@smoke the editor finds and replaces, and Replace all is one undo step', async ({ page }) => {
  const f = await assistantFixture();
  try {
    acceptDocs(f.root);
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await awaitAccepted(page);
    await page.evaluate(() => selectFile('docs/Original.md'));
    await page.locator('#docReader .markdown-line', { hasText: 'Human original content.' }).click();
    const editor = page.locator('#docEditor');
    const original = '# Original document\n\nMémo one\nmemo two\nMEMO three\n';
    await editor.fill(original);
    await openMore(page);
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

// R2 review: a tap never edits a doc that waits in « To review », even opened from the tree, outside review mode.
// With Git, an agent change is `changed` (not `reviewRequired`): the queue entry alone must block the tap.
for (const withGit of [false, true]) test('a doc waiting in To review is not edited by a tap' + (withGit ? ' (Git project)' : ''), async ({ page }) => {
  const f = await assistantFixture();
  try {
    const file = path.join(f.root, 'docs/Other.md');
    acceptDocs(f.root);
    if (withGit) {
      const git = (args) => execFileSync('git', args, { cwd: f.root, stdio: 'ignore' });
      git(['init', '--initial-branch=main']);
      git(['config', 'user.email', 'tap@example.test']);
      git(['config', 'user.name', 'Tap Test']);
      git(['add', '.']);
      git(['commit', '-m', 'Initial']);
    }
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    fs.writeFileSync(file, '# Other document\n\nAgent rewrote this line.\n');
    await expect.poll(() => page.evaluate(async () => {
      applyBackgroundReportPayload(await api('/api/reports'));
      return state.docqa?.queue?.find((item) => item.path === 'docs/Other.md')?.reviewReason || null;
    }), { timeout: 10_000 }).toBe(withGit ? 'changed' : 'unverified-current');
    await page.evaluate(() => { state.autosaveDelayMs = 100; return selectFile('docs/Other.md'); });
    await expect(page.locator('#docReader')).toContainText('Agent rewrote this line.');
    await expect(page.locator('#docReader[data-tap-edit]')).toHaveCount(0);
    await expect(page.locator('[data-doc-review-banner]')).toContainText('Changed by an agent');
    await page.locator('#docReader .markdown-line', { hasText: 'Agent rewrote this line.' }).click();
    await page.keyboard.type('x');
    await page.waitForTimeout(600);
    await expect(page.locator('#docEditor')).toHaveCount(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('# Other document\n\nAgent rewrote this line.\n');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

// R5 acceptance: DESIGN.md changed by an agent, opened from the tree: the text keeps its full width (no Git diff
// panel opens by itself) and one banner says what changed, with Accept / Reject. Accept makes it a normal doc.
test('a changed doc opened from the tree shows the review banner, not the Git diff panel', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const file = path.join(f.root, 'docs/DESIGN.md');
    fs.writeFileSync(file, '# Design\n\nFirst rule.\n\nSecond rule.\n');
    acceptDocs(f.root, ['docs/Original.md', 'docs/Other.md', 'docs/DESIGN.md']);
    const git = (args) => execFileSync('git', args, { cwd: f.root, stdio: 'ignore' });
    git(['init', '--initial-branch=main']);
    git(['config', 'user.email', 'banner@example.test']);
    git(['config', 'user.name', 'Banner Test']);
    git(['add', '.']);
    git(['commit', '-m', 'Initial']);
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    const agentText = '# Design\n\nFirst rule, rewritten by an agent.\n\nSecond rule.\n\nThird rule.\n';
    fs.writeFileSync(file, agentText);
    await expect.poll(() => page.evaluate(async () => {
      applyBackgroundReportPayload(await api('/api/reports'));
      return state.docqa?.queue?.find((item) => item.path === 'docs/DESIGN.md')?.reviewReason || null;
    }), { timeout: 10_000 }).toBe('changed');
    const explorerToggle = page.locator('#explorerOpen:visible, #sidebarToggle:visible').first();
    if (await page.locator('.app').evaluate((node) => node.classList.contains('sidebar-collapsed'))) await explorerToggle.click();
    await page.locator('#search').fill('DESIGN');
    await page.locator('#files [data-file-path="docs/DESIGN.md"]').click();
    // On a phone the Explorer is a drawer over the doc: close it to reach the banner.
    if ((page.viewportSize()?.width || 1280) < 820) await page.getByRole('button', { name: 'Close explorer' }).click();
    const banner = page.locator('[data-doc-review-banner]');
    await expect(banner).toContainText('Changed by an agent');
    await expect(banner).toContainText(/\+3 −1/);
    await expect(banner.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
    await expect(page.locator('#docReader')).toContainText('rewritten by an agent');
    await expect(page.locator('.diff-panel')).toHaveCount(0);
    // Full width: the file panel fills the viewer; nothing sits beside it.
    const widths = await page.evaluate(() => [document.querySelector('#viewer').clientWidth, document.querySelector('.file-panel').getBoundingClientRect().width]);
    expect(widths[1]).toBeGreaterThan(widths[0] - 40);
    // The Git diff stays one click away.
    await openMore(page);
    await page.getByRole('button', { name: 'Changes since last commit', exact: true }).click();
    await expect(page.locator('.diff-panel')).toBeVisible();
    await openMore(page);
    await page.getByRole('button', { name: 'Hide changes', exact: true }).click();
    await expect(page.locator('.diff-panel')).toHaveCount(0);

    await banner.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(banner).toHaveCount(0);
    await expect(page.locator('#docReader[data-tap-edit]')).toBeVisible();
    expect(fs.readFileSync(file, 'utf8')).toBe(agentText);
    expect(await page.evaluate(() => state.docqa.queue.some((item) => item.path === 'docs/DESIGN.md'))).toBe(false);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

// R8a acceptance: a README reads as clean text. Proportional font, a measured line, its relative image shown,
// code and tables in fixed width, no line numbers. A doc waiting in « To review » keeps them.
test('a README reads as clean text with its image; line numbers only in review', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const file = path.join(f.root, 'docs/README.md');
    fs.mkdirSync(path.join(f.root, 'docs/img'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'docs/img/diagram.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    const prose = 'Context Room keeps the documents of each project readable for the people who own them, and it shows what agents changed. '.repeat(5).trim();
    const text = '# Readme\n\n' + prose + '\n\n![Diagram](img/diagram.png)\n\n| Name | Role |\n|------|------|\n';
    fs.writeFileSync(file, text);
    acceptDocs(f.root, ['docs/Original.md', 'docs/Other.md', 'docs/README.md']);
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await awaitAccepted(page, ['docs/README.md']);
    await page.evaluate(() => selectFile('docs/README.md'));
    const reader = page.locator('#docReader');
    await expect(reader.locator('p.markdown-line').first()).toContainText('Context Room keeps');
    const image = reader.locator('img.markdown-image');
    await expect(image).toHaveCount(1);
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('[data-doc-review-banner]')).toHaveCount(0);
    const look = await reader.evaluate((node) => {
      const prose = node.querySelector('p.markdown-line'), range = document.createRange();
      range.selectNodeContents(prose);
      const rows = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      return {
        numbers: [...node.querySelectorAll('.markdown-line')].map((line) => getComputedStyle(line, '::before').content).filter((content) => !['none', 'normal'].includes(content)),
        prose: getComputedStyle(prose).fontFamily, table: getComputedStyle(node.querySelector('.markdown-line.table')).fontFamily,
        perLine: prose.textContent.length / rows, rows,
      };
    });
    expect(look.numbers).toEqual([]);
    expect(look.prose).not.toMatch(/mono/i);
    expect(look.table).toMatch(/mono/i);
    test.info().annotations.push({ type: 'characters per line', description: String(Math.round(look.perLine)) });
    // The measure aims at 68-72 characters; system fonts differ by platform, so the check is wider. Phones are narrower.
    if ((page.viewportSize()?.width || 1280) >= 1000) { expect(look.perLine).toBeGreaterThan(58); expect(look.perLine).toBeLessThan(84); }

    // An agent changes it: the doc waits in « To review » and its lines are numbered again.
    fs.writeFileSync(file, text + '\nAgent line.\n');
    await expect.poll(() => page.evaluate(async () => {
      applyBackgroundReportPayload(await api('/api/reports'));
      return Boolean(state.docqa?.queue?.some((item) => item.path === 'docs/README.md'));
    }), { timeout: 10_000 }).toBe(true);
    await page.evaluate(() => selectFile('docs/README.md'));
    await expect(page.locator('[data-doc-review-banner]')).toBeVisible();
    await expect(reader.locator('img.markdown-image')).toHaveCount(1);
    expect(await reader.locator('p.markdown-line').first().evaluate((line) => getComputedStyle(line, '::before').content)).toBe('"3"');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('a finger drag on the doc never opens the editor; a short tap does', async ({ page }) => {
  const f = await assistantFixture();
  try {
    acceptDocs(f.root);
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await awaitAccepted(page);
    await page.evaluate(() => selectFile('docs/Original.md'));
    await expect(page.locator('#docReader[data-tap-edit]')).toBeVisible();
    const tap = (dy) => page.locator('#docReader .markdown-line', { hasText: 'Human original content.' }).evaluate((line, dy) => {
      const rect = line.getBoundingClientRect(), x = rect.left + 20, y = rect.top + rect.height / 2;
      line.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
      line.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y + dy }));
    }, dy);
    await tap(40);
    await page.waitForTimeout(300);
    await expect(page.locator('#docEditor')).toHaveCount(0);
    await tap(2);
    await expect(page.locator('#docEditor')).toBeFocused();
    // In the editor, a finger that moves does not move the caret.
    const before = await page.locator('#docEditor').evaluate((node) => node.selectionStart);
    await page.locator('#docEditor').evaluate((node) => {
      const rect = node.getBoundingClientRect(), x = rect.left + 30, y = rect.top + 10;
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y }));
      node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y + 60 }));
    });
    expect(await page.locator('#docEditor').evaluate((node) => node.selectionStart)).toBe(before);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('a failed save says Not saved · Retry, and Retry writes the text', async ({ page }) => {
  const f = await assistantFixture();
  try {
    acceptDocs(f.root);
    const file = path.join(f.root, 'docs/Original.md');
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await awaitAccepted(page);
    await page.evaluate(() => { state.autosaveDelayMs = 100; return selectFile('docs/Original.md'); });
    await page.route('**/api/file/save-reviewed', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"disk full"}' }));
    await page.locator('#docReader .markdown-line', { hasText: 'Human original content.' }).click();
    const editor = page.locator('#docEditor');
    await editor.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
    await editor.pressSequentially('Kept.');
    await expect(page.locator('.doc-save-failed')).toHaveText('Not saved · Retry');
    await expect(page.locator('[data-save-retry]')).toHaveCount(1);
    await expect(editor).toHaveValue(/Kept\./);
    await page.unroute('**/api/file/save-reviewed');
    await page.locator('[data-save-retry]').click();
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('Kept.');
    await expect(page.locator('.doc-save-failed')).toHaveCount(0);
    await expect(page.locator('.file-panel .file-title')).not.toHaveClass(/unsaved/);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('a hidden tab or another page saves the doc at once, without a dialog', async ({ page }) => {
  const f = await assistantFixture();
  try {
    acceptDocs(f.root);
    const file = path.join(f.root, 'docs/Original.md');
    page.on('dialog', (dialog) => { throw new Error('unexpected dialog: ' + dialog.message()); });
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await awaitAccepted(page);
    await page.evaluate(() => { state.autosaveDelayMs = 1e9; return selectFile('docs/Original.md'); });
    await page.locator('#docReader .markdown-line', { hasText: 'Human original content.' }).click();
    const editor = page.locator('#docEditor');
    await editor.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
    await editor.pressSequentially('Hidden.');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
    });
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('Hidden.');
    await editor.pressSequentially(' Left.');
    await page.evaluate(() => goHub());
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('Hidden. Left.');
    await expect.poll(() => page.evaluate(() => state.page)).not.toBe('file');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});
