import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const format of ['md', 'html']) test(`@smoke recovered ${format} drafts remain working until explicit submission and human review`, async ({ page }, testInfo) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-recovered-draft-ui-'))), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { previous[key] = process.env[key]; process.env[key] = path.join(base, key); }
  const root = path.join(base, 'project'), source = path.join(base, 'legacy'), snapshot = path.join(base, 'snapshot');
  const filePath = `docs/Recovered.${format}`, original = format === 'md' ? '\ufeff# Retained notebook ideas\r\n\r\nA sentence recovered from the tablet. 🖊️\r\n' : '<h1>Retained visual ideas</h1><p>An original recovered page.</p>';
  let runtime;
  try {
    fs.mkdirSync(root); fs.mkdirSync(source);
    const { initializeContextRoomProject, writeMemoryWebappSettings, migrateLisiereDraft, createMemoryServer } = await import('../../src/context_room.mjs');
    const { registerContextHubProject } = await import('../../src/context_hub.mjs');
    const { exportLisiereSnapshot } = await import('../../src/lisiere_snapshot.mjs');
    const { inspectLisiereSnapshot } = await import('../../src/lisiere_inventory.mjs');
    initializeContextRoomProject(root, { title: 'Recovered ideas', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
    writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
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
    const draftButton = page.locator(`[data-local-draft="${imported.proposalId}"]`), reviewRow = page.locator('[data-context-room-review^="local-proposal:"]').filter({ hasText: `Recovered draft · Recovered.${format}` });
    await expect(draftButton).toBeVisible({ timeout: 45000 }); await expect(reviewRow).toHaveCount(0);
    await draftButton.click();
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
    await expect(draftButton).toBeVisible({ timeout: 45000 }); await draftButton.click();
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
    expect(JSON.parse(fs.readFileSync(path.join(root, imported.recovery, 'source-draft.json'))).content).toBe(original);
    expect(migrateLisiereDraft(root, { ...options, apply: true, expectedRevision: plan.revision }).proposalId).toBe(imported.proposalId);
    expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed()) await page.goto('about:blank').catch(() => {});
    if (runtime) { await new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections?.(); }); await runtime.waitForShutdown(); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
