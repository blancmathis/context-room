import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { assistantFixture } from '../fixtures/assistant.mjs';
import { legacyConversationSnapshot } from '../fixtures/lisiere-conversations.mjs';
import { migrateLisiereConversation } from '../../src/context_room.mjs';

const fully = (page, locator) => locator.evaluate(node => { const box = node.getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= innerWidth + 0.5 && box.top >= 0 && box.bottom <= innerHeight + 0.5; });

test('@assistant after New conversation (empty), reopening selects the imported history, not the empty conversation', async ({ page }) => {
  const f = await assistantFixture();
  try {
    const legacy = await legacyConversationSnapshot(f.base, { desktop: true });
    const options = { snapshot: legacy.snapshot, selector: legacy.selector, path: 'docs/Original.md' }, authority = { storageRoot: path.join(f.base, 'private-assistant') };
    const preview = migrateLisiereConversation(f.root, options, authority);
    const applied = migrateLisiereConversation(f.root, { ...options, apply: true, expectedRevision: preview.revision }, authority);
    const open = async () => { await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId)); await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click(); return page.getByRole('complementary', { name: 'Original document conversation' }); };
    let pane = await open(); const select = pane.getByLabel('Saved conversations for this original source');
    await expect(select).toHaveValue(applied.conversationId);
    await pane.getByRole('button', { name: 'New conversation' }).click();
    await expect.poll(() => select.evaluate(node => node.options.length)).toBe(2);
    await expect(select).not.toHaveValue(applied.conversationId);
    pane = await open();
    await expect(pane.getByLabel('Saved conversations for this original source')).toHaveValue(applied.conversationId);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant an idle notebook conversation closes with its notebook and no longer covers the Hub home', async ({ page }) => {
  const f = await assistantFixture();
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(async () => { window.notebookUnderTest = await openContextRoomNotebook('docs/Sketch.crnb'); });
    const notebook = page.getByRole('dialog', { name: 'Notebook: docs/Sketch.crnb', exact: true });
    await expect(notebook).toHaveAttribute('data-save-state', 'confirmed');
    await notebook.getByRole('button', { name: 'Ask about selection', exact: true }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }); await expect(pane).toBeVisible();
    await pane.getByRole('button', { name: 'Minimize conversation' }).click();
    await notebook.getByRole('button', { name: 'Close notebook', exact: true }).click();
    await expect(pane).toHaveCount(0);
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});

test('@assistant on a phone with a 330 px keyboard, the focused message field is fully inside the panel and the viewport', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Touch emulation with a coarse pointer is checked in Chromium.');
  const f = await assistantFixture();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();
  try {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).tap();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' }), textbox = pane.getByRole('textbox', { name: 'Message to the original document agent' });
    await expect(textbox).toBeVisible();
    await page.setViewportSize({ width: 390, height: 330 }); await textbox.tap(); await expect(textbox).toBeFocused();
    await expect.poll(() => textbox.evaluate(node => { const box = node.getBoundingClientRect(), panel = node.closest('.assistant-panel').getBoundingClientRect(); return box.top >= Math.max(0, panel.top) - 0.5 && box.bottom <= Math.min(innerHeight, panel.bottom) + 0.5; })).toBe(true);
  } finally { await context.close(); await f.close(); }
});

for (const width of [1024, 800]) test(`@layout settings tabs and texts stay inside a ${width} px viewport`, async ({ browser }) => {
  const f = await assistantFixture();
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' }), page = await context.newPage();
  try {
    await page.goto(f.url + '/?view=hub'); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.locator('#settingsButton').click();
    const tab = page.locator('#settings-tab-advanced-extensions'); await expect(tab).toBeVisible();
    expect(await fully(page, tab)).toBe(true);
    const outside = await page.evaluate(() => [...document.querySelectorAll('.settings-tabs *')].filter(node => node.offsetParent && node.getBoundingClientRect().right > innerWidth + 1).map(node => node.tagName + '.' + node.className));
    expect(outside).toEqual([]);
  } finally { await context.close(); await f.close(); }
});

test('@layout the graph filters stay inside a 1024 px viewport', async ({ browser }) => {
  const f = await assistantFixture();
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, colorScheme: 'dark' }), page = await context.newPage();
  try {
    await page.goto(f.url + '/?view=hub'); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.locator('#graphOpen').click();
    await expect(page.locator('#graphRelationFilter')).toBeVisible();
    const outside = await page.evaluate(() => [...document.querySelectorAll('.graph-filterbar *, .graph-toolbar *')].filter(node => node.offsetParent && node.getBoundingClientRect().width && node.getBoundingClientRect().right > innerWidth + 1).map(node => node.tagName + '#' + node.id + '.' + node.className));
    expect(outside).toEqual([]);
  } finally { await context.close(); await f.close(); }
});

test('@layout the file review dialog keeps Reload review / Reject file / Accept file in view at 1280×800 without scrolling', async ({ browser }) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-fix14-review-'));
  const previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { previous[key] = process.env[key]; process.env[key] = path.join(parent, key); }
  const { initializeContextRoomProject, writeMemoryWebappSettings, writeDocReviewDecision, createLocalDocumentationProposal, submitLocalDocumentationProposal, createMemoryServer } = await import('../../src/context_room.mjs');
  const { registerContextHubProject } = await import('../../src/context_hub.mjs');
  const root = path.join(parent, 'project'); fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/guide.md'), '# Project guide\n\n' + 'Accepted guidance line.\n\n'.repeat(12));
  initializeContextRoomProject(root, { title: 'Fix14 review', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  writeDocReviewDecision(root, 'docs/guide.md', { status: 'verified' });
  const proposal = createLocalDocumentationProposal(root, { title: 'Tall review proposal' });
  fs.writeFileSync(path.join(proposal.editRoot, 'docs/guide.md'), '# Project guide\n\n' + 'Proposed guidance line.\n\n'.repeat(12));
  submitLocalDocumentationProposal(root, proposal.id); registerContextHubProject(root, { title: 'Fix14 review' });
  const { server, waitForShutdown } = createMemoryServer({ root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' }), page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/?view=hub`);
    const row = page.locator('[data-context-room-review^="local-proposal:"]').filter({ hasText: proposal.title });
    await expect(row).toBeVisible({ timeout: 45000 }); await row.click();
    const dialog = page.getByRole('dialog', { name: proposal.title });
    await expect(dialog.getByRole('textbox', { name: 'Proposed content: docs/guide.md' })).toBeVisible();
    for (const name of ['Reload review', 'Reject file', 'Accept file']) {
      const button = dialog.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const inside = await button.evaluate(node => { const box = node.getBoundingClientRect(), shell = node.closest('dialog').getBoundingClientRect(); return box.top >= shell.top - 0.5 && box.bottom <= Math.min(shell.bottom, innerHeight) + 0.5; });
      expect(inside, name).toBe(true);
    }
  } finally {
    if (!page.isClosed()) await page.goto('about:blank');
    await context.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); await waitForShutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
