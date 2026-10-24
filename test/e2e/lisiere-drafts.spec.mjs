import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { tabletDraftSnapshot } from '../fixtures/lisiere-tablet-drafts.mjs';

for (const originKind of ['md', 'html', 'tablet']) test(`@smoke recovered ${originKind} drafts remain working until explicit submission and human review`, async ({ page }, testInfo) => {
  const format = originKind === 'tablet' ? 'md' : originKind;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-recovered-draft-ui-'))), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { previous[key] = process.env[key]; process.env[key] = path.join(base, key); }
  const root = path.join(base, 'project'), source = path.join(base, 'legacy'); let snapshot = path.join(base, 'snapshot');
  const filePath = `docs/Recovered.${format}`;
  let original = format === 'md' ? '\ufeff# Retained notebook ideas\r\n\r\nA sentence recovered from the tablet. 🖊️\r\n' : '<h1>Retained visual ideas</h1><p>An original recovered page.</p>';
  let runtime;
  try {
    fs.mkdirSync(root);
    const { initializeContextRoomProject, writeMemoryWebappSettings, migrateLisiereDraft, createMemoryServer } = await import('../../src/context_room.mjs');
    const { registerContextHubProject } = await import('../../src/context_hub.mjs');
    const { exportLisiereSnapshot } = await import('../../src/lisiere_snapshot.mjs');
    const { inspectLisiereSnapshot } = await import('../../src/lisiere_inventory.mjs');
    initializeContextRoomProject(root, { title: 'Recovered ideas', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
    writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
    let selector;
    if (originKind === 'tablet') {
      const retained = await tabletDraftSnapshot(base); snapshot = retained.snapshot; selector = retained.selector; original = retained.content;
    } else {
      fs.mkdirSync(source);
      execFileSync('python3', ['-B', '-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root TEXT); CREATE TABLE boards(id TEXT PRIMARY KEY,title TEXT,project TEXT,revision INTEGER); CREATE TABLE objects(board TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(board,id)); CREATE TABLE drafts(project TEXT,path TEXT,device TEXT,base TEXT,content TEXT,version INTEGER,PRIMARY KEY(project,path,device));')
 db.execute('INSERT INTO projects VALUES(?,?,?)',('original','Original project','/synthetic/original'))
 db.execute('INSERT INTO drafts VALUES(?,?,?,?,?,?)',('original',sys.argv[2],'tablet',None,sys.argv[3],9))`, path.join(source, 'workspace.sqlite'), filePath, original], { stdio: 'pipe' });
      const preview = await exportLisiereSnapshot({ source, output: snapshot });
      await exportLisiereSnapshot({ source, output: snapshot, apply: true, expectedRevision: preview.revision });
      selector = inspectLisiereSnapshot(snapshot, { kind: 'drafts' }).items[0].selector;
    }
    const options = { snapshot, selector, path: filePath }, plan = migrateLisiereDraft(root, options);
    const imported = migrateLisiereDraft(root, { ...options, apply: true, expectedRevision: plan.revision });
    registerContextHubProject(root, { title: 'Recovered ideas' });
    runtime = createMemoryServer({ root }); await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`, errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/?hub=1&view=hub');
    const draftButton = page.locator(`[data-local-draft="${imported.proposalId}"]`), reviewRow = page.locator('[data-context-room-review^="local-proposal:"]').filter({ hasText: `Recovered draft · Recovered.${format}` });
    // Click only once the queue is confirmed fresh and clean: the page is settled.
    const settled = page.getByRole('status').filter({ hasText: 'No submitted review pending' });
    await expect(draftButton).toBeVisible({ timeout: 45000 }); await expect(settled).toBeVisible({ timeout: 45000 }); await expect(reviewRow).toHaveCount(0);
    // A Hub refresh may re-render the queue between press and release.
    // The unchanged draft button must survive it, or the click is lost.
    await draftButton.hover(); await page.mouse.down();
    await page.locator('#contextRoomReviewSearch').dispatchEvent('input');
    await page.mouse.up();
    const dialog = page.getByRole('dialog', { name: `Recovered draft · Recovered.${format}` });
    let expected = original;
    if (format === 'md') {
      const editor = dialog.getByRole('textbox', { name: `Working content: ${filePath}` });
      await expect(editor).toHaveValue(original.replace(/\r\n/g, '\n'));
      await expect(dialog.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
      expected = original + '\r\nA human clarification, saved before review.\r\n';
      await editor.fill(expected.replace(/\r\n/g, '\n'));
      await expect(dialog.getByRole('button', { name: 'Submit for review', exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toBeVisible(); await expect(dialog.getByRole('status')).toContainText('Save the draft');
      await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
      await expect(dialog.getByRole('status')).toContainText('Draft saved');
      expect(fs.readFileSync(path.join(imported.editRoot, filePath), 'utf8')).toBe(expected);
    } else {
      await expect(dialog.frameLocator(`iframe[title="Working preview: ${filePath}"]`).getByRole('heading', { name: 'Retained visual ideas' })).toBeVisible();
      await expect(dialog.locator('textarea')).toHaveCount(0);
    }
    expect(fs.existsSync(path.join(root, filePath))).toBe(false);
    const audit = new AxeBuilder({ page }).include('dialog[open]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
    // Audit the owner controls, not the original document's sandboxed origin.
    // Legacy mode avoids WebKit's stalled auxiliary-page creation with srcdoc.
    if (format === 'html') audit.setLegacyMode(true).exclude('iframe');
    const axe = await audit.analyze();
    expect(axe.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`recovered-${format}-working.png`), fullPage: true });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await page.reload();
    await expect(draftButton).toBeVisible({ timeout: 45000 }); await expect(settled).toBeVisible({ timeout: 45000 }); await draftButton.click();
    if (format === 'md') await expect(dialog.getByRole('textbox')).toHaveValue(expected.replace(/\r\n/g, '\n'));
    else await expect(dialog.locator('iframe')).toBeVisible();
    await dialog.getByRole('button', { name: 'Submit for review', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(reviewRow).toBeVisible({ timeout: 45000 }); await expect(draftButton).toHaveCount(0);
    expect(fs.existsSync(path.join(root, filePath))).toBe(false);
    await reviewRow.click();
    const review = page.getByRole('dialog', { name: `Recovered draft · Recovered.${format}` });
    if (format === 'md') {
      const editor = review.getByRole('textbox', { name: `Proposed content: ${filePath}` });
      await expect(editor).toHaveValue(expected.replace(/\r\n/g, '\n'));
      await expect(review.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible();
      expected += '\r\nA final human review correction.\r\n';
      await editor.fill(expected.replace(/\r\n/g, '\n'));
      await review.getByRole('button', { name: 'Save and accept file', exact: true }).click();
    } else {
      await expect(review.frameLocator(`iframe[title="Proposed: ${filePath}"]`).getByRole('heading', { name: 'Retained visual ideas' })).toBeVisible();
      await review.getByRole('button', { name: 'Accept file', exact: true }).click();
    }
    await expect.poll(() => fs.existsSync(path.join(root, filePath)) && fs.readFileSync(path.join(root, filePath), 'utf8')).toBe(expected);
    const retained = JSON.parse(fs.readFileSync(path.join(root, imported.recovery, 'source-draft.json')));
    expect(originKind === 'tablet' ? retained.reconstructed.content : retained.content).toBe(original);
    if (originKind === 'tablet') expect(retained.source.delivery).toBe('not-inferred');
    expect(migrateLisiereDraft(root, { ...options, apply: true, expectedRevision: plan.revision }).proposalId).toBe(imported.proposalId);
    expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed()) await page.goto('about:blank').catch(() => {});
    if (runtime) { await new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections?.(); }); await runtime.waitForShutdown(); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('working draft editor replaces 6400 matches in a 1.7 MB draft and undoes it', async ({ page }) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-draft-find-ui-'))), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { previous[key] = process.env[key]; process.env[key] = path.join(base, key); }
  const root = path.join(base, 'project'), source = path.join(base, 'legacy'), snapshot = path.join(base, 'snapshot'), filePath = 'docs/Recovered.md';
  const original = '# Notes\n\nFirst draft.\n';
  let runtime;
  try {
    fs.mkdirSync(root);
    const { initializeContextRoomProject, writeMemoryWebappSettings, migrateLisiereDraft, createMemoryServer } = await import('../../src/context_room.mjs');
    const { registerContextHubProject } = await import('../../src/context_hub.mjs');
    const { exportLisiereSnapshot } = await import('../../src/lisiere_snapshot.mjs');
    const { inspectLisiereSnapshot } = await import('../../src/lisiere_inventory.mjs');
    initializeContextRoomProject(root, { title: 'Recovered ideas', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
    writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
    fs.mkdirSync(source);
    execFileSync('python3', ['-B', '-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root TEXT); CREATE TABLE boards(id TEXT PRIMARY KEY,title TEXT,project TEXT,revision INTEGER); CREATE TABLE objects(board TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(board,id)); CREATE TABLE drafts(project TEXT,path TEXT,device TEXT,base TEXT,content TEXT,version INTEGER,PRIMARY KEY(project,path,device));')
 db.execute('INSERT INTO projects VALUES(?,?,?)',('original','Original project','/synthetic/original'))
 db.execute('INSERT INTO drafts VALUES(?,?,?,?,?,?)',('original',sys.argv[2],'tablet',None,sys.argv[3],9))`, path.join(source, 'workspace.sqlite'), filePath, original], { stdio: 'pipe' });
    const preview = await exportLisiereSnapshot({ source, output: snapshot });
    await exportLisiereSnapshot({ source, output: snapshot, apply: true, expectedRevision: preview.revision });
    const selector = inspectLisiereSnapshot(snapshot, { kind: 'drafts' }).items[0].selector;
    const options = { snapshot, selector, path: filePath }, plan = migrateLisiereDraft(root, options);
    const imported = migrateLisiereDraft(root, { ...options, apply: true, expectedRevision: plan.revision });
    registerContextHubProject(root, { title: 'Recovered ideas' });
    runtime = createMemoryServer({ root }); await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`, errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/?hub=1&view=hub');
    const draftButton = page.locator(`[data-local-draft="${imported.proposalId}"]`);
    await expect(draftButton).toBeVisible({ timeout: 45000 });
    await expect(page.getByRole('status').filter({ hasText: 'No submitted review pending' })).toBeVisible({ timeout: 45000 });
    await draftButton.click();
    const dialog = page.getByRole('dialog', { name: 'Recovered draft · Recovered.md' });
    const editor = dialog.getByRole('textbox', { name: `Working content: ${filePath}` });
    await expect(editor).toHaveValue(original);
    const big = ('Mémo ' + 'x'.repeat(260) + '\n').repeat(6400);
    expect(big.length).toBeGreaterThan(1_700_000);
    // Playwright's WebKit fill() sends the 1.7 MB through its text-insertion path and takes over 100 s even on a bare textarea; setting the value and firing input costs about 1 s and is what the editor listens to.
    await editor.evaluate((node, text) => { node.value = text; node.dispatchEvent(new Event('input', { bubbles: true })); }, big);
    await dialog.getByRole('button', { name: 'Find', exact: true }).click();
    const bar = dialog.locator('.find-bar');
    await bar.getByRole('searchbox', { name: 'Find' }).fill('memo');
    await expect(bar.locator('[data-find-count]')).toHaveText('6,400 matches');
    await bar.getByRole('textbox', { name: 'Replace with' }).fill('Note');
    await bar.getByRole('button', { name: 'Replace all', exact: true }).click();
    await expect(bar.locator('[data-find-count]')).toHaveText('Replaced 6,400 matches');
    expect(await editor.evaluate(node => node.value.startsWith('Note x') && !node.value.includes('Mémo'))).toBe(true);
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(editor).toHaveValue(big);
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(editor).toHaveValue(original);
    await expect(dialog.getByRole('button', { name: 'Submit for review', exact: true })).toBeDisabled().catch(() => {});
    expect(fs.existsSync(path.join(root, filePath))).toBe(false);
    expect(fs.readFileSync(path.join(imported.editRoot, filePath), 'utf8')).toBe(original);
    expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed()) await page.goto('about:blank').catch(() => {});
    if (runtime) { await new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections?.(); }); await runtime.waitForShutdown(); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
