import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createMemoryServer, initializeContextRoomProject, writeMemoryWebappSettings } from '../../src/context_room.mjs';
import { readNotebook } from '../../src/notebooks.mjs';
import { contextRoomWebAssetBundle } from '../../src/context_room.mjs';
import { webAppResponse, webAppVersion } from '../../src/web_app.mjs';

test.use({ serviceWorkers: 'allow' });

async function fixture() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pwa-browser-'))), root = path.join(base, 'project'), previous = {};
  for (const key of ['HOME', 'CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME', 'GIT_CONFIG_GLOBAL']) { previous[key] = process.env[key]; process.env[key] = key === 'GIT_CONFIG_GLOBAL' ? '/dev/null' : path.join(base, key); }
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); fs.writeFileSync(path.join(root, 'docs/guide.md'), '# Synthetic guide\n');
  initializeContextRoomProject(root, { title: 'Synthetic PWA', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  const runtime = createMemoryServer({ root }), updates = { generation: 0, disconnected: false, rejectedConnections: 0 };
  // Replace only the worker bytes in this synthetic runtime. The separate asset
  // contract checks versioned module cohorts; this scenario tests SW lifecycle.
  const handlers = runtime.server.listeners('request');
  if (handlers.length !== 1) throw new Error('Expected the exact isolated HTTP handler.');
  runtime.server.removeListener('request', handlers[0]);
  runtime.server.on('request', (req, res) => {
    // CDP page offline emulation does not necessarily cover an already running
    // worker. Reject every server connection too, including worker fetches.
    if (updates.disconnected) { updates.rejectedConnections++; req.socket.destroy(); return; }
    if (updates.generation && req.method === 'GET' && req.url === '/service-worker.js') {
      const worker = webAppResponse(new URL(req.url, 'http://localhost'), contextRoomWebAssetBundle());
      const body = worker.body.replace('const BUILD = ' + JSON.stringify(webAppVersion()), 'const BUILD = ' + JSON.stringify(webAppVersion() + '-synthetic-update-' + updates.generation));
      res.writeHead(200, worker.headers); res.end(body); return;
    }
    handlers[0](req, res);
  });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  return { base, root, runtime, updates, origin: `http://127.0.0.1:${runtime.server.address().port}`, async close() {
    await new Promise(resolve => { runtime.server.closeAllConnections(); runtime.server.close(resolve); }); await runtime.waitForShutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(base, { recursive: true, force: true });
  } };
}
async function watch(page) {
  await page.addInitScript(() => document.addEventListener('context-room-notebook-opened', event => { window.testNotebook = event.detail; }));
}
async function online(page, origin) {
  await page.goto(origin); await page.waitForFunction(() => typeof openContextRoomNotebook === 'function' && Boolean(state.ownerMutationNonce && state.projectId));
}
async function pen(page, offset = 0) {
  const box = await page.locator('canvas.notebook-canvas').boundingBox(), cdp = await page.context().newCDPSession(page);
  const x = box.x + 75, y = box.y + 50 + offset;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.25 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 100, y: y + 20, button: 'left', buttons: 1, pointerType: 'pen', force: 0.75 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 120, y: y + 30, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 });
  await page.evaluate(() => testNotebook.surface.settle()); await cdp.detach();
}

test('@pwa shared editor survives a waiting worker update and two offline browser restarts, syncing pressure exactly once', async ({ playwright }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'Persistent Chromium process restart is tested once; shared layout has separate profiles.');
  test.setTimeout(180_000);
  const f = await fixture(), profile = path.join(f.base, 'browser-profile'), errors = []; let context;
  const launch = async offline => {
    context = await playwright.chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 820, height: 1180 }, offline });
    const page = context.pages()[0] || await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await watch(page); return page;
  };
  try {
    let page = await launch(false); await online(page, f.origin);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await online(page, f.origin); await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.evaluate(() => openContextRoomNotebook('docs/Restart.crnb'));
    const id = await page.locator('.notebook-dialog').getAttribute('data-resource-id');
    await pen(page); await expect.poll(() => readNotebook(f.root, id).document.objects.length).toBe(1);
    await expect.poll(() => readNotebook(f.root, id).document.objects[0].points.map(p => p[2])).toEqual(expect.arrayContaining([0.25, 0.75]));
    await expect(page.locator('.notebook-dialog')).toHaveAttribute('data-save-state', 'confirmed');
    const peer = await context.newPage(); await peer.goto(f.origin);
    await expect.poll(() => peer.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    f.updates.generation = 1;
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting))).toBe(true);
    expect(await page.evaluate(async () => (await caches.keys()).filter(name => name.endsWith('-synthetic-update-1')).length)).toBe(1);
    // Both old clients stay open and their editor is not reloaded or replaced.
    expect(await page.evaluate(() => testNotebook.surface.document.objects.length)).toBe(1);
    await peer.close();
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting))).toBe(true);
    f.updates.disconnected = true; f.runtime.server.closeAllConnections();
    await context.setOffline(true); await pen(page, 70);
    await expect(page.locator('.notebook-dialog')).toHaveAttribute('data-save-state', 'pending');
    const pending = await page.evaluate(async () => (await testNotebook.client.state()).operations.map(op => op.operationId)); expect(pending.length).toBeGreaterThan(0); expect(pending.every(id => typeof id === 'string' && id.length > 8)).toBe(true);
    await context.close();
    page = await launch(true); await page.goto(f.origin);
    await expect(page.getByText('Mac unavailable · open a locally saved working notebook.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /docs\/Restart.crnb/ }).click();
    await expect(page.locator('.notebook-dialog')).toHaveAttribute('data-save-state', 'pending');
    expect(await page.evaluate(async () => (await testNotebook.client.state()).operations.map(op => op.operationId))).toEqual(pending);
    expect(await page.evaluate(() => testNotebook.surface.document.objects.length)).toBe(2);
    await pen(page, 120); await page.screenshot({ path: info.outputPath('pwa-offline-portrait.png') });
    await context.close();
    page = await launch(true); await page.goto(f.origin); await page.getByRole('button', { name: /docs\/Restart.crnb/ }).click();
    expect(await page.evaluate(() => testNotebook.surface.document.objects.length)).toBe(3);
    f.updates.disconnected = false;
    await context.setOffline(false);
    await expect(page.locator('.notebook-dialog')).toHaveAttribute('data-save-state', 'confirmed', { timeout: 30_000 });
    const snapshot = readNotebook(f.root, id); expect(snapshot.document.objects.length).toBe(3);
    expect(new Set(snapshot.document.objects.map(o => o.id)).size).toBe(3);
    for (const object of snapshot.document.objects) expect(object.points.map(p => p[2])).toEqual(expect.arrayContaining([0.25, 0.75]));
    expect(fs.existsSync(path.join(f.root, 'docs/Restart.crnb'))).toBe(false);
    const cached = await page.evaluate(async () => { const entries = []; for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) entries.push(new URL(request.url).pathname); return entries; });
    expect(cached.some(p => p.startsWith('/api/') || p === '/' || p.startsWith('/reviews/'))).toBe(false);
    expect(errors).toEqual([]);
  } catch (error) {
    const page = context?.pages()[0];
    await info.attach('offline-restart-diagnostic', { body: JSON.stringify({ errors, rejectedConnections: f.updates.rejectedConnections,
      page: await page?.evaluate(async () => ({ location: location.href, entry: document.querySelector('meta[name="context-room-web-entry"]')?.content,
        controlled: Boolean(navigator.serviceWorker.controller), caches: await caches.keys(), text: document.body.innerText.slice(0, 1800) })).catch(() => null) }, null, 2), contentType: 'application/json' });
    throw error;
  } finally { await context?.close(); await f.close(); }
});

test('@pwa @tablet the same notebook controls remain reachable in tablet portrait, landscape and keyboard-height views', async ({ page }, info) => {
  const f = await fixture(); await watch(page);
  try {
    await online(page, f.origin); await page.evaluate(() => openContextRoomNotebook('docs/Layout.crnb'));
    const dialog = page.locator('.notebook-dialog');
    for (const [name, width, height] of [['portrait', 820, 1180], ['landscape', 1180, 820], ['keyboard', 820, 420]]) {
      await page.setViewportSize({ width, height });
      for (const label of ['Close notebook', 'Submit for review', 'Pen', 'Eraser', 'Select / lasso', 'Pan', 'Rectangle', 'Undo gesture', 'Redo gesture']) {
        const button = dialog.getByRole('button', { name: label, exact: true });
        await expect(button).toHaveCount(1);
        await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport();
        const box = await button.boundingBox(); expect(box.height + 0.001).toBeGreaterThanOrEqual(44); // Firefox reports subpixel float rounding.
      }
      await dialog.getByRole('button', { name: 'E-ink contrast', exact: true }).scrollIntoViewIfNeeded();
      if (await dialog.getByRole('button', { name: 'E-ink contrast', exact: true }).getAttribute('aria-pressed') !== 'true') await dialog.getByRole('button', { name: 'E-ink contrast', exact: true }).click();
      await page.screenshot({ path: info.outputPath('shared-notebook-' + name + '.png') });
      const violations = await new AxeBuilder({ page }).include('.notebook-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); expect(violations.violations).toEqual([]);
    }
    expect(await page.locator('canvas.notebook-canvas').count()).toBe(1);
  } finally { await page.goto('about:blank'); await f.close(); }
});
