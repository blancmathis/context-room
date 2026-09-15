import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { initializeContextRoomProject, writeMemoryWebappSettings, createMemoryServer, createContextRoomDeviceService } from '../../src/context_room.mjs';
import { listNotebooks, readNotebook, mutateNotebook, decodeNotebook } from '../../src/notebooks.mjs';
import { buildDocumentationCorpus } from '../../src/documentation.mjs';
import { listLocalProposals } from '../../src/local_proposals.mjs';
import { listSharedProposalWorkspaces } from '../../src/shared_context.mjs';
import { addNotebookSharedFixture, removeNotebookSharedFixture, notebookFixtureGit } from '../fixtures/notebook_shared.mjs';

async function fixture(page, { devices = false, shared = false } = {}) {
  const scratch = fs.mkdtempSync(path.join(shared ? os.homedir() : os.tmpdir(), '.context-room-notebook-browser-'));
  const base = fs.realpathSync(scratch), root = path.join(base, 'project'), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME', 'GIT_CONFIG_GLOBAL']) { previous[key] = process.env[key]; process.env[key] = key === 'GIT_CONFIG_GLOBAL' ? '/dev/null' : path.join(scratch, key); }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); fs.writeFileSync(path.join(root, 'docs/guide.md'), '# Synthetic guide\n');
  initializeContextRoomProject(root, { title: 'Synthetic notebooks', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  const sharedFixture = shared ? addNotebookSharedFixture(root, base) : null;
  const deviceService = devices ? createContextRoomDeviceService({ root, stateRoot: path.join(base, 'private-devices') }) : null;
  if (deviceService) await deviceService.listen();
  const runtime = createMemoryServer({ root, deviceService }); await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${runtime.server.address().port}`, errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/'); await page.waitForFunction(() => typeof openContextRoomNotebook === 'function' && Boolean(state.ownerMutationNonce && state.projectId));
  return { root, runtime, origin, errors, deviceService, sharedFixture, async close() {
    try { if (!page.isClosed()) { await page.context().setOffline(false); await page.goto('about:blank'); } }
    finally { await new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections(); }); await runtime.waitForShutdown(); if (deviceService) await deviceService.close(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } removeNotebookSharedFixture(base); }
  } };
}
async function open(page, name = 'docs/Sketch.crnb') {
  await page.evaluate(async name => { window.testNotebook = await openContextRoomNotebook(name); }, name);
  const dialog = page.locator('dialog.notebook-dialog[open]'); await expect(dialog).toBeVisible(); await expect(dialog).toHaveAttribute('data-save-state', 'confirmed'); return dialog;
}
async function draw(page, { start = [90, 90], end = [260, 160], up = true } = {}) {
  const box = await page.locator('canvas.notebook-canvas').boundingBox();
  await page.mouse.move(box.x + start[0], box.y + start[1]); await page.mouse.down(); await page.mouse.move(box.x + end[0], box.y + end[1], { steps: 8 }); if (up) await page.mouse.up();
}

test('@smoke @notebook full owner pairing requires an explicit choice in the existing settings', async ({ page }, testInfo) => {
  const f = await fixture(page, { devices: true });
  try {
    await page.locator('#settingsButton').click();
    await page.locator('#settings-tab-preferences').click();
    await page.locator('summary').filter({ hasText: 'Connected devices' }).click();
    await page.getByRole('button', { name: 'Manage connected devices', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Connected devices', exact: true });
    const create = sheet.getByRole('button', { name: 'Create owner pairing code', exact: true });
    await expect(create).toBeDisabled();
    await sheet.getByLabel('Device name', { exact: true }).fill('Synthetic full tablet');
    await sheet.getByRole('checkbox').check();
    await create.click();
    const code = sheet.getByRole('textbox', { name: 'One-use owner pairing code' });
    await expect(code).toBeVisible();
    const ticket = JSON.parse(await code.inputValue());
    expect(ticket.grants).toEqual([{ mode: 'owner', serverId: f.deviceService.serverId }]);
    const paired = f.deviceService.authority.pair(ticket);
    await sheet.getByRole('button', { name: 'Close devices', exact: true }).click();
    await page.getByRole('button', { name: 'Manage connected devices', exact: true }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Disconnect Synthetic full tablet', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('owner-pairing-permission.png') });
    const accessibility = await new AxeBuilder({ page }).include('.connected-devices-dialog').analyze();
    expect(accessibility.violations).toEqual([]);
    await sheet.getByRole('button', { name: 'Disconnect Synthetic full tablet', exact: true }).click();
    expect(f.deviceService.authority.list().find(device => device.id === paired.device.id).revokedAt).toBeTruthy();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('@smoke @notebook explicit view following stops on human input and presentation retains the notebook', async ({ page }, testInfo) => {
  const f = await fixture(page, { devices: true }); let pollTimer, release;
  try {
    const notebook = await open(page), resourceId = await notebook.getAttribute('data-resource-id'), scene = readNotebook(f.root, resourceId);
    const paired = f.deviceService.authority.pair(f.deviceService.createPairing({ projectId: f.runtime.projectId, paths: ['docs/Sketch.crnb'], label: 'View tablet' }));
    const target = { projectId: f.runtime.projectId, resourceId, path: scene.locator.path, locationRevision: scene.locator.revision };
    const authenticate = () => f.deviceService.authority.authenticate(paired.token);
    let deviceView = { sequence: 1, mode: 'share', target, viewport: [100, 50, 450, 300] }, latest, acknowledgeFrames = false;
    const poll = () => {
      if (acknowledgeFrames && latest?.frame) deviceView = { ...deviceView, receipt: { ...latest.frame, viewport: latest.frame.viewport } };
      latest = f.deviceService.navigation.poll(paired.device.id, authenticate, { clientSessionId: 'browser-view-fixture', view: deviceView }).view;
      return latest;
    };
    poll(); pollTimer = setInterval(poll, 500);
    const original = await page.evaluate(() => testNotebook.surface.viewportBounds());
    await expect(notebook).toHaveAttribute('data-view-mode', 'independent');
    expect(await page.evaluate(() => testNotebook.surface.viewportBounds())).toEqual(original);
    await notebook.getByRole('button', { name: 'Connect tablet', exact: true }).click();
    await page.getByRole('button', { name: 'Follow View tablet', exact: true }).click();
    await expect(notebook.locator('.notebook-view-state')).toContainText('Following View tablet.');
    await expect.poll(() => latest.receipt?.sequence).toBe(1);
    expect(await page.evaluate(() => testNotebook.surface.viewportBounds())).not.toEqual(original);
    const held = new Promise(resolve => { release = resolve; }); let observed;
    const requested = new Promise(resolve => { observed = resolve; });
    let complete; const continued = new Promise(resolve => { complete = resolve; });
    await page.route('**/api/devices/view', async route => { observed(); await held; await route.continue(); complete(); });
    deviceView = { ...deviceView, sequence: 2, viewport: [3000, 3000, 800, 500] }; poll();
    await requested;
    const humanView = await page.evaluate(() => ({ ...testNotebook.surface.view }));
    await draw(page, { start: [60, 40], end: [160, 80], up: false });
    await expect(notebook).toHaveAttribute('data-view-mode', 'independent');
    // Keep test interception stable until pen receipts finish. Disabling it
    // during a Chromium request can strand an unrelated notebook upload.
    release(); await continued; await page.mouse.up();
    await expect(notebook).toHaveAttribute('data-save-state', 'confirmed');
    expect(await page.evaluate(() => ({ ...testNotebook.surface.view }))).toEqual(humanView);

    deviceView = { sequence: 3, mode: 'follow', target }; poll();
    await notebook.getByRole('button', { name: 'Connect tablet', exact: true }).click();
    await page.getByRole('button', { name: 'Share my view with View tablet', exact: true }).click();
    await expect.poll(() => latest.frame?.target.resourceId).toBe(resourceId);
    await expect(notebook.locator('.notebook-view-state')).toContainText('display not yet confirmed');
    // Browser status contract only. Native rendering has its separate Android proof.
    // A narrow toolbar/status reflow can publish another viewport. The fixture
    // follows every subsequent frame, like the native client's rendered receipt.
    acknowledgeFrames = true; poll();
    await expect(notebook.locator('.notebook-view-state')).toHaveText('Current view displayed on View tablet.');
    await notebook.getByRole('button', { name: 'Presentation', exact: true }).click();
    await expect(notebook).toHaveClass(/notebook-presentation/);
    await expect(notebook.getByRole('toolbar', { name: 'Notebook tools' })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('notebook-presentation.png'), fullPage: true });
    const accessibility = await new AxeBuilder({ page }).include('.notebook-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    await notebook.getByRole('button', { name: 'Exit presentation', exact: true }).click();
    await expect(notebook).not.toHaveClass(/notebook-presentation/);
    await expect(notebook.getByRole('toolbar', { name: 'Notebook tools' })).toBeVisible();
    expect(fs.existsSync(path.join(f.root, scene.locator.path))).toBe(false);
    expect(f.errors).toEqual([]);
  } catch (error) {
    await testInfo.attach('notebook-save-state', { contentType: 'application/json', body: Buffer.from(JSON.stringify(await page.evaluate(() => ({
      status: document.querySelector('.notebook-state')?.textContent, error: document.querySelector('.notebook-error')?.textContent,
      gesture: testNotebook.surface.gesture?.kind, pendingSurfaceTasks: testNotebook.surface.tasks.size,
      finishingStrokes: testNotebook.surface.finishingStrokes.size, flushPending: Boolean(testNotebook.client.flushing),
      body: document.querySelector('.notebook-dialog')?.outerHTML.slice(-5000)
    })))) });
    await page.screenshot({ path: testInfo.outputPath('notebook-before-cleanup.png') }); throw error;
  } finally { release?.(); clearInterval(pollTimer); await f.close(); }
});

test('@smoke @notebook an owner sees the Shared destination and submits one exact frozen drawing', async ({ page }, testInfo) => {
  const f = await fixture(page, { shared: true });
  try {
    const dialog = await open(page), main = notebookFixtureGit(f.sharedFixture.remote, ['rev-parse', 'main']);
    await draw(page); await expect(dialog).toHaveAttribute('data-save-state', 'confirmed');
    await dialog.getByRole('combobox', { name: 'Notebook proposal destination' }).selectOption('shared');
    await expect(dialog.getByText('Shared: Synthetic Shared › Drawing project › Sketch.crnb.', { exact: false })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('notebook-shared-destination.png'), fullPage: true });
    const response = page.waitForResponse(response => response.url().endsWith('/api/notebooks/submit') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Submit for review', exact: true }).click();
    const receipt = await (await response).json(); expect(receipt.status).toBe('submitted'); expect(receipt.scope).toBe('shared');
    expect(receipt.accepted).toBe(false); expect(receipt.target.repositoryPath).toBe('projects/drawing/docs/Sketch.crnb');
    expect(listSharedProposalWorkspaces(f.root)).toHaveLength(1);
    await draw(page, { start: [90, 190], end: [250, 250] });
    await expect(dialog).toHaveAttribute('data-save-state', 'confirmed');
    const working = readNotebook(f.root, listNotebooks(f.root)[0].id);
    expect(working.document.objects).toHaveLength(2);
    const frozen = notebookFixtureGit(f.sharedFixture.remote, ['show', `${receipt.proposalRevision}:${receipt.target.repositoryPath}`]);
    expect(decodeNotebook(Buffer.from(frozen)).objects).toHaveLength(1);
    expect(notebookFixtureGit(f.sharedFixture.remote, ['rev-parse', 'main'])).toBe(main);
    expect(fs.existsSync(path.join(f.root, 'docs/Sketch.crnb'))).toBe(false);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('@smoke @notebook owner pairs, requests an exact display receipt and revokes a device', async ({ page }, testInfo) => {
  const f = await fixture(page, { devices: true });
  try {
    const notebook = await open(page);
    await notebook.getByRole('button', { name: 'Connect tablet', exact: true }).click();
    const pairing = page.getByRole('dialog', { name: 'Connect tablet', exact: true });
    await expect(pairing).toBeVisible();
    await pairing.getByLabel('Device name', { exact: true }).fill('Synthetic tablet');
    await pairing.getByRole('button', { name: 'Create pairing code', exact: true }).click();
    const code = pairing.getByRole('textbox', { name: 'One-use tablet pairing code', exact: true });
    await expect(code).toBeVisible();
    const ticket = JSON.parse(await code.inputValue());
    expect(ticket.grants).toEqual([{ mode: 'draw', projectId: f.runtime.projectId, paths: ['docs/Sketch.crnb'] }]);
    const pairedDevice = f.deviceService.authority.pair(ticket), device = pairedDevice.device;
    const authenticate = () => f.deviceService.authority.authenticate(pairedDevice.token);
    const clientSessionId = 'synthetic-native-session';
    f.deviceService.navigation.poll(device.id, authenticate, { clientSessionId });
    // Pairing code is an ephemeral synthetic credential; screenshots show the form, not its value.
    await pairing.getByRole('button', { name: 'Close connection', exact: true }).click();
    await notebook.getByRole('button', { name: 'Connect tablet', exact: true }).click();
    await expect(pairing.getByRole('button', { name: 'Disconnect Synthetic tablet', exact: true })).toBeVisible();
    const display = pairing.getByRole('status', { name: 'Synthetic tablet display status', exact: true });
    await expect(display).toHaveText('Tablet connected.');
    await pairing.getByRole('button', { name: 'Open on Synthetic tablet', exact: true }).click();
    await expect(display).toHaveText('Opening requested · waiting for the tablet.');
    const command = f.deviceService.navigation.poll(device.id, authenticate, { clientSessionId, busy: true }).command;
    expect(command.target.resourceId).toBe(await notebook.getAttribute('data-resource-id'));
    expect(command.target.projectId).toBe(f.runtime.projectId);
    f.deviceService.navigation.receipt(device.id, authenticate, { clientSessionId, operationId: command.operationId, status: 'deferred' });
    await expect(display).toHaveText('Tablet is drawing or editing · opening deferred.');
    // This is the browser's receipt rendering contract. Actual native rendering is
    // separately checked by the Android instrumentation, never inferred from this fixture.
    f.deviceService.navigation.receipt(device.id, authenticate, { clientSessionId, operationId: command.operationId, status: 'applied', target: command.target });
    await expect(display).toHaveText('Displayed on Synthetic tablet.');
    expect(fs.existsSync(path.join(f.root, 'docs/Sketch.crnb'))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('notebook-device-pairing.png'), fullPage: true });
    const accessibility = await new AxeBuilder({ page }).include('.notebook-pair-dialog').analyze();
    expect(accessibility.violations).toEqual([]);
    await pairing.getByRole('button', { name: 'Disconnect Synthetic tablet', exact: true }).click();
    await expect.poll(() => f.deviceService.authority.list().find(item => item.id === device.id).revokedAt).not.toBeNull();
    await pairing.getByRole('button', { name: 'Create pairing code', exact: true }).click();
    await expect(code).toBeVisible(); const unused = JSON.parse(await code.inputValue());
    const cancelled = page.waitForResponse(response => response.url().endsWith('/api/devices/cancel-pairing') && response.request().method() === 'POST');
    await pairing.getByRole('button', { name: 'Close connection', exact: true }).click();
    expect((await cancelled).ok()).toBe(true);
    expect(() => f.deviceService.authority.pair(unused)).toThrow('Pairing expired or is invalid.');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

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

test('@smoke @a11y @notebook object controls retain keyboard focus through independent scene updates', async ({ page }) => {
  const f = await fixture(page);
  try {
    const dialog = await open(page); await draw(page); await expect(dialog).toHaveAttribute('data-save-state', 'confirmed');
    if (!await dialog.getByRole('complementary', { name: 'Notebook objects and selection' }).isVisible()) await dialog.getByRole('button', { name: 'Objects', exact: true }).click();
    await dialog.locator('.notebook-objects button').first().focus();
    await page.evaluate(() => { window.originalObjectControl = document.activeElement; });
    const scene = readNotebook(f.root, await dialog.getAttribute('data-resource-id'));
    mutateNotebook(f.root, { protocolVersion: 1, resourceId: scene.resourceId, operationId: 'independent-keyboard-shape', locationRevision: scene.locator.revision,
      edits: [{ kind: 'put', id: 'independent-shape', expectedRevision: 0, object: { type: 'rect', x: 60, y: 80, width: 90, height: 70 } }] },
    { actor: { kind: 'human', id: 'other-synthetic-surface' }, canWrite: () => true });
    await expect(dialog.locator('[data-object-id="independent-shape"]')).toBeVisible();
    expect(await page.evaluate(() => originalObjectControl.isConnected && document.activeElement === originalObjectControl)).toBe(true);
  } finally { await f.close(); }
});

test('@smoke @notebook legacy connector routes and text spacing remain editable on the rendered canvas', async ({ page }, testInfo) => {
  const f = await fixture(page);
  try {
    const dialog = await open(page), scene = readNotebook(f.root, await dialog.getAttribute('data-resource-id'));
    const values = [
      { id: 'upper', type: 'rect', x: 200, y: 100, width: 120, height: 50 },
      { id: 'lower', type: 'rect', x: 200, y: 300, width: 120, height: 50 },
      { id: 'return', type: 'connector', from: 'upper', to: 'lower', fromSide: 'left', toSide: 'left', route: 'outside-left', routeOffset: 48 },
      { id: 'label', type: 'text', x: 350, y: 122, width: 180, height: 100, fontSize: 22, lineHeight: 1.4, text: 'Original\nSecond line' },
    ];
    mutateNotebook(f.root, { protocolVersion: 1, resourceId: scene.resourceId, operationId: 'legacy-preview', locationRevision: scene.locator.revision,
      edits: values.map(object => ({ kind: 'put', id: object.id, expectedRevision: 0, object })) }, { actor: { kind: 'import', id: 'synthetic-import' }, canWrite: () => true });
    await expect.poll(() => page.evaluate(() => testNotebook.surface.document.objects.length)).toBe(4);
    await dialog.getByRole('button', { name: 'Fit drawing', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const { canvas, view } = testNotebook.surface, ratio = canvas.width / canvas.clientWidth;
      const x = Math.round((view.x + 152 * view.scale) * ratio);
      // Verify a solid stretch after multiple paints, not one coincidentally
      // dark pixel from a leaked selection dash pattern.
      for (let worldY = 180; worldY < 250; worldY += 3) {
        const y = Math.round((view.y + worldY * view.scale) * ratio);
        const pixels = canvas.getContext('2d').getImageData(x - 2, y, 5, 1).data; let dark = false;
        for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset] < 128 && pixels[offset + 1] < 128 && pixels[offset + 2] < 128 && pixels[offset + 3] > 200) dark = true;
        if (!dark) return false;
      }
      return true;
    })).toBe(true);
    expect(await page.evaluate(() => testNotebook.surface.document.objects.find(item => item.id === 'label').lineHeight)).toBe(1.4);
    await dialog.locator('canvas').screenshot({ path: testInfo.outputPath('legacy-editable-canvas.png') });
    expect(fs.existsSync(path.join(f.root, 'docs/Sketch.crnb'))).toBe(false);
    expect(readNotebook(f.root, scene.resourceId).accepted).toBe(false); expect(f.errors).toEqual([]);
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
