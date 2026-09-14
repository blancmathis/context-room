import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { initializeContextRoomProject, writeMemoryWebappSettings, createMemoryServer } from '../../src/context_room.mjs';
import { listNotebooks, readNotebook, mutateNotebook, decodeNotebook } from '../../src/notebooks.mjs';
import { buildDocumentationCorpus } from '../../src/documentation.mjs';
import { listLocalProposals } from '../../src/local_proposals.mjs';

async function fixture(page) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-notebook-browser-'))), root = path.join(base, 'project'), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { previous[key] = process.env[key]; process.env[key] = path.join(base, key); }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); fs.writeFileSync(path.join(root, 'docs/guide.md'), '# Synthetic guide\n');
  initializeContextRoomProject(root, { title: 'Synthetic notebooks', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  const runtime = createMemoryServer({ root }); await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${runtime.server.address().port}`, errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/'); await page.waitForFunction(() => typeof openContextRoomNotebook === 'function' && Boolean(state.ownerMutationNonce && state.projectId));
  return { root, runtime, origin, errors, async close() { await page.context().setOffline(false); if (!page.isClosed()) await page.goto('about:blank'); await new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections(); }); await runtime.waitForShutdown(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(base, { recursive: true, force: true }); } };
}
async function open(page, name = 'docs/Sketch.crnb') {
  await page.evaluate(async name => { window.testNotebook = await openContextRoomNotebook(name); }, name);
  const dialog = page.locator('dialog.notebook-dialog[open]'); await expect(dialog).toBeVisible(); await expect(dialog).toHaveAttribute('data-save-state', 'confirmed'); return dialog;
}
async function draw(page, { start = [90, 90], end = [260, 160], up = true } = {}) {
  const box = await page.locator('canvas.notebook-canvas').boundingBox();
  await page.mouse.move(box.x + start[0], box.y + start[1]); await page.mouse.down(); await page.mouse.move(box.x + end[0], box.y + end[1], { steps: 8 }); if (up) await page.mouse.up();
}

test('@smoke @notebook continuous ink, independent remote changes, undo, frozen review correction and accepted-only corpus', async ({ page }, testInfo) => {
  const f = await fixture(page);
  try {
    const dialog = await open(page); const resourceId = await dialog.getAttribute('data-resource-id');
    await draw(page, { up: false });
    await expect.poll(() => readNotebook(f.root, resourceId).document.objects.length).toBe(1);
    // The first point is a distinct canonical receipt; wait for the moving prefix while the pen stays down.
    await expect.poll(() => readNotebook(f.root, resourceId).document.objects[0]?.points.length || 0).toBeGreaterThan(1);
    const before = readNotebook(f.root, resourceId);
    mutateNotebook(f.root, { protocolVersion: 1, resourceId, operationId: 'independent-agent', locationRevision: before.locator.revision, edits: [{ kind: 'put', id: 'agent-object', expectedRevision: 0, object: { id: 'agent-object', type: 'rect', x: 400, y: 100, width: 120, height: 80 } }] }, { actor: { kind: 'agent', id: 'synthetic-agent' }, canWrite: () => true });
    await expect.poll(() => page.evaluate(() => testNotebook.surface.document.objects.length)).toBe(2);
    expect(await page.evaluate(() => testNotebook.surface.gesture.kind)).toBe('ink');
    await page.mouse.up(); await expect(dialog).toHaveAttribute('data-save-state', 'confirmed');
    await dialog.getByRole('button', { name: 'Undo gesture', exact: true }).click();
    await expect.poll(() => readNotebook(f.root, resourceId).document.objects.map(o => o.id)).toEqual(['agent-object']);
    await dialog.getByRole('button', { name: 'Redo gesture', exact: true }).click(); await expect.poll(() => readNotebook(f.root, resourceId).document.objects.length).toBe(2);
    await expect(dialog).toHaveAttribute('data-save-state', 'confirmed');
    await page.screenshot({ path: testInfo.outputPath('notebook-desktop.png'), fullPage: true });
    expect(buildDocumentationCorpus(f.root).documents.some(d => d.path === 'docs/Sketch.crnb')).toBe(false);
    await dialog.getByRole('button', { name: 'Submit for review', exact: true }).click(); await expect.poll(() => listLocalProposals(f.root).length).toBe(1);
    const proposal = listLocalProposals(f.root)[0];
    const frozenRevision = readNotebook(f.root, resourceId).document.revision;
    await draw(page, { start: [150, 190], end: [300, 250] }); await expect.poll(() => readNotebook(f.root, resourceId).document.objects.length).toBe(3);
    await dialog.getByRole('button', { name: 'Close notebook', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await page.evaluate(async proposalId => { const { openLocalProposalReview } = await import('/assets/local-proposal-review.mjs'); await openLocalProposalReview({ item: { proposalId, type: 'local-proposal', title: 'Frozen notebook review', files: ['docs/Sketch.crnb'] }, ...captureNotebookApi(), onChange: () => {} }); }, proposal.id);
    const review = page.getByRole('dialog', { name: 'Frozen notebook review', exact: true });
    await expect(review.locator('.notebook-review-render svg')).toHaveCount(1); await expect(review.locator('textarea')).toHaveCount(0);
    await expect(review.locator('svg g[data-object-id]')).toHaveCount(2);
    await review.getByRole('button', { name: 'Correct notebook', exact: true }).click();
    const correction = page.locator('dialog.notebook-dialog[open]'); await expect(correction).toBeVisible();
    await expect(correction).toHaveAttribute('data-scene-revision', String(frozenRevision)); // exact frozen version, not the later working scene
    await correction.getByRole('button', { name: 'Rectangle', exact: true }).click();
    await draw(page, { start: [70, 240], end: [140, 285] });
    await correction.getByRole('button', { name: 'Use this correction', exact: true }).click(); await expect(correction).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Save and accept file', exact: true })).toBeVisible();
    expect(fs.existsSync(path.join(f.root, 'docs/Sketch.crnb'))).toBe(false);
    await review.getByRole('button', { name: 'Save and accept file', exact: true }).click();
    await expect.poll(() => fs.existsSync(path.join(f.root, 'docs/Sketch.crnb'))).toBe(true);
    const accepted = decodeNotebook(fs.readFileSync(path.join(f.root, 'docs/Sketch.crnb'))); expect(accepted.objects).toHaveLength(3);
    expect(accepted.objects.filter(o => o.type === 'ink')).toHaveLength(1);
    expect(readNotebook(f.root, resourceId).document.objects.filter(o => o.type === 'ink')).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('@smoke @notebook offline device cache survives reopening without a false receipt and replays once', async ({ page }) => {
  const f = await fixture(page);
  try {
    let dialog = await open(page); const resourceId = await dialog.getAttribute('data-resource-id');
    await page.context().setOffline(true); await draw(page); await expect(dialog.locator('[role=status]')).toContainText('Saved locally');
    expect(readNotebook(f.root, resourceId).document.objects).toHaveLength(0);
    const expected = await page.evaluate(async () => (await testNotebook.client.exportRecovery()).operations.map(operation => operation.operationId));
    await dialog.getByRole('button', { name: 'Close notebook', exact: true }).click();
    // The already loaded app shell opens exactly the same IndexedDB scope without a server.
    await page.evaluate(async () => { window.testNotebook = await openContextRoomNotebook('docs/Sketch.crnb'); });
    dialog = page.locator('dialog.notebook-dialog[open]'); await expect(dialog.locator('[role=status]')).toContainText('Saved locally');
    expect(await page.evaluate(async () => (await testNotebook.client.exportRecovery()).operations.map(operation => operation.operationId))).toEqual(expected);
    await page.context().setOffline(false); await dialog.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(dialog).toHaveAttribute('data-save-state', 'confirmed'); expect(readNotebook(f.root, resourceId).document.objects).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('@smoke @notebook rapid handwriting survives slow local storage with separate undo', async ({ page }) => {
  const f = await fixture(page);
  try {
    const dialog = await open(page), resourceId = await dialog.getAttribute('data-resource-id');
    await page.evaluate(() => {
      const enqueue = testNotebook.surface.enqueue;
      const gate = new Promise(resolve => { window.releaseNotebookStorage = resolve; });
      testNotebook.surface.enqueue = async (...args) => { await gate; return enqueue(...args); };
    });
    await draw(page, { start: [40, 30], end: [95, 60] });
    await draw(page, { start: [115, 30], end: [175, 60] });
    expect(readNotebook(f.root, resourceId).document.objects).toHaveLength(0);
    expect(await page.evaluate(() => testNotebook.surface.finishingStrokes.size)).toBe(2);
    await page.evaluate(() => releaseNotebookStorage());
    await expect(dialog).toHaveAttribute('data-save-state', 'confirmed');
    expect(readNotebook(f.root, resourceId).document.objects).toHaveLength(2);
    await dialog.getByRole('button', { name: 'Undo gesture', exact: true }).click();
    await expect.poll(() => readNotebook(f.root, resourceId).document.objects.length).toBe(1);
    await dialog.getByRole('button', { name: 'Redo gesture', exact: true }).click();
    await expect.poll(() => readNotebook(f.root, resourceId).document.objects.length).toBe(2);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('@a11y @layout @notebook tactile targets, grayscale and keyboard-accessible objects', async ({ page }, testInfo) => {
  const f = await fixture(page);
  try {
    const dialog = await open(page); await draw(page); await expect(dialog).toHaveAttribute('data-save-state', 'confirmed');
    await dialog.getByRole('button', { name: 'E-ink contrast', exact: true }).click();
    const results = await new AxeBuilder({ page }).include('dialog.notebook-dialog[open]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
    const box = await dialog.boundingBox(), canvas = await dialog.locator('canvas').boundingBox();
    expect(canvas.height).toBeGreaterThan(100); expect(box.width).toBeLessThanOrEqual(page.viewportSize().width);
    const targetSizes = await dialog.locator('button:visible').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)); expect(Math.min(...targetSizes)).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('notebook-eink.png'), fullPage: true });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
