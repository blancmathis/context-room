import fs from 'node:fs';
import { test, expect } from '@playwright/test';

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error('Missing Context Room UX fixture');
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

// In the shared fixture, items 3 and 4 belong to one project: an accept on
// item 3 opens item 4 without a page reload. (Leaving a project reloads the
// page, so that open waits for the saves on purpose.)
async function reachSameProjectPair(page) {
  const bar = page.locator('#reviewFlowBar');
  for (const step of [2, 3]) {
    await expect(bar.locator('[data-review-flow="later"]')).toBeEnabled({ timeout: 30_000 });
    await page.keyboard.press('l');
    await expect(bar).toContainText(new RegExp('^' + step + ' of \\d+'), { timeout: 30_000 });
  }
  await expect(bar.locator('[data-review-flow="accept"]')).toBeEnabled({ timeout: 30_000 });
  return bar;
}

// Only "Later" and "Stop" here: the fixture is shared, so this test must not decide any review.
test('@smoke review flow walks pending files across projects and ends with a summary', async ({ page }) => {
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  const start = page.locator('[data-review-flow-panel="start"]');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await expect(start).toContainText(/Review one after another · \d+ files/);
  await start.click();

  const bar = page.locator('#reviewFlowBar');
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(bar).toContainText(/^1 of \d+/);
  await expect(bar.locator('[data-review-flow="later"]')).toBeEnabled();
  await page.keyboard.press('l');
  await expect(bar).toContainText(/^2 of \d+/, { timeout: 30_000 });

  const requests = [];
  page.on('request', request => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  await bar.locator('[data-review-flow="stop"]').click();
  const panel = page.locator('#reviewFlowPanel');
  await expect(panel).toContainText('Review stopped', { timeout: 30_000 });
  await expect(panel).toContainText('0 accepted · 0 changes requested · 1 later');
  await expect(bar).toBeHidden();
  // The end of a review reloads the queue only: no full Hub refresh (Git rescan, Shared sync).
  await expect.poll(() => requests.includes('GET /api/context-hub/review-queue')).toBe(true);
  expect(requests).not.toContain('POST /api/context-hub/refresh');
  await panel.locator('[data-review-flow-panel="close"]').click();
  await expect(start).toBeVisible();
});

// Accept never waits for the server write: the next file opens while the save
// is still on its way, and a save that fails stays visible. The writes are
// answered here and never reach the shared fixture.
test('@smoke review flow accept opens the next file at once and keeps a failed save visible', async ({ page }) => {
  const data = fixture();
  const held = [];
  const decisions = [];
  for (const route of ['**/api/docqa/review', '**/api/docqa/review-baseline']) {
    await page.route(route, (request) => {
      decisions.push(new URL(request.request().url()).pathname);
      held.push(request);
    });
  }
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  const start = page.locator('[data-review-flow-panel="start"]');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();
  const bar = await reachSameProjectPair(page);
  await page.keyboard.press('a');
  await expect(bar).toContainText(/^4 of \d+/, { timeout: 30_000 });

  // The save starts once the next file is shown; nothing has answered it yet.
  await expect.poll(() => held.length, { timeout: 30_000 }).toBe(1);
  await held.shift().fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'review changed', code: 'review_revision_conflict' }) });
  const alert = bar.locator('[role="alert"]');
  await expect(alert).toContainText('Not saved', { timeout: 30_000 });
  await expect(alert).toContainText('a newer version is waiting');
  expect(decisions.length, 'one write per decision, never retried').toBe(1);

  await bar.locator('[data-review-flow="stop"]').click();
  const panel = page.locator('#reviewFlowPanel');
  await expect(panel).toContainText('Review stopped', { timeout: 30_000 });
  await expect(panel).toContainText('1 not saved');
  await panel.locator('[data-review-flow-panel="close"]').click();
});

const REVIEW_FLOW_KEY = 'context-room:review-flow:v1';
const flowResults = (page) => page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key) || '{}').results || {}, REVIEW_FLOW_KEY);

// A page reloaded while a save is on its way (a project change reloads the
// page too) cannot see the save end; nor can a page restored from the
// back-forward cache. The next page reads the outcome back from the review
// queue: the summary ends as saved or not saved, never "saving". The page is
// put in that state directly, so nothing reaches the shared fixture.
test('@smoke review flow saves cut by a reload end as saved or not saved, never saving', async ({ page }) => {
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  const start = page.locator('[data-review-flow-panel="start"]');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();
  await reachSameProjectPair(page);
  await page.evaluate((key) => {
    const flow = JSON.parse(window.sessionStorage.getItem(key));
    const [orphan, , recorded] = flow.items;
    // One save with its outbox record, one "saving" left without any record.
    flow.results[orphan.id] = 'saving';
    flow.results[recorded.id] = 'saving';
    window.sessionStorage.setItem(key, JSON.stringify(flow));
    window.localStorage.setItem('context-room:review-flow-outbox:v1', JSON.stringify([{
      requestId: 'cut-by-reload', flowStartedAt: flow.startedAt, itemId: recorded.id, projectId: recorded.projectId,
      path: recorded.path, status: 'verified', expectedContentHash: recorded.currentHash, tab: window.sessionStorage.getItem('context-room:tab-id') || '', at: new Date().toISOString(),
    }]));
  }, REVIEW_FLOW_KEY);
  await page.reload();

  await expect.poll(async () => Object.values(await flowResults(page)).filter((result) => result !== 'later'), { timeout: 30_000 }).toEqual(['failed', 'failed']);
  const failures = await page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key)).failures, REVIEW_FLOW_KEY);
  expect(failures.map((failure) => failure.path).sort()).toEqual(['AGENTS.md', 'docs/runbook.md']);
  expect(await page.evaluate(() => window.localStorage.getItem('context-room:review-flow-outbox:v1'))).toBeNull();
});

// A decision the queue had not started when the page went away is sent on
// pagehide, base first, then review. Requests sent while a page unloads skip
// Playwright routes, so the file changes first and the server refuses the
// decision. The next page shows it as not saved instead of "saving".
test('@smoke review flow decision sent on pagehide that does not land is visible after reopening', async ({ page }) => {
  const data = fixture();
  let holdOpen = false;
  const hung = [];
  await page.route(/\/api\/file(\/[a-z-]+)?\?/, (request) => (holdOpen ? hung.push(request) : request.fallback()));
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  const start = page.locator('[data-review-flow-panel="start"]');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();
  await reachSameProjectPair(page);
  // The next file never finishes opening, so the save never starts in the page.
  holdOpen = true;
  await page.keyboard.press('a');
  await expect.poll(() => hung.length, { timeout: 30_000 }).toBeGreaterThan(0);
  holdOpen = false;
  const runbook = `${data.projects.beacon.root}/docs/runbook.md`;
  const before = fs.readFileSync(runbook, 'utf8');
  try {
    fs.writeFileSync(runbook, `${before}\nWritten after the reviewer looked.\n`);
    await page.goto('about:blank');
    for (const request of hung.splice(0)) await request.abort().catch(() => {});
    await page.goto(`${data.origin}/?hub=1&view=hub`);

    await expect.poll(async () => Object.values(await flowResults(page)).filter((result) => result !== 'later'), { timeout: 30_000 }).toEqual(['failed']);
    const failures = await page.evaluate((key) => JSON.parse(window.sessionStorage.getItem(key)).failures, REVIEW_FLOW_KEY);
    expect(failures).toEqual([{ path: 'docs/runbook.md', message: 'a newer version is waiting' }]);
  } finally {
    fs.writeFileSync(runbook, before);
  }
});

// A decision with a base (accepting an external change) is sent on pagehide
// with both requests at once. Requests sent while a page unloads skip
// Playwright routes, so the page's own fetch is wrapped: the base never
// answers, as in a page that is gone, and the review must still be sent.
test('@smoke review flow pagehide sends the review even when the base never answers', async ({ page }) => {
  const data = fixture();
  let holdOpen = false;
  const hung = [];
  await page.route(/\/api\/file(\/[a-z-]+)?\?/, (request) => (holdOpen ? hung.push(request) : request.fallback()));
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  const start = page.locator('[data-review-flow-panel="start"]');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();
  await reachSameProjectPair(page);
  holdOpen = true;
  await page.evaluate(() => {
    window.__decisionCalls = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, window.location.href).pathname;
      if (url === '/api/docqa/review-baseline' || url === '/api/docqa/review') {
        window.__decisionCalls.push(url);
        // Nothing reaches the shared fixture; the base never answers.
        return url.endsWith('baseline') ? new Promise(() => {}) : Promise.reject(new TypeError('page gone'));
      }
      return realFetch(input, init);
    };
    // The shown file carries an external change, so accept sends a base too.
    state.externalChange = { source: 'review', path: state.selected, diskHash: state.savedHash, diskContent: state.saved + '\nAdded outside.\n', baseContent: state.saved, reviewDecisions: {} };
    void decideReviewFlow('accept');
  });
  await expect.poll(() => hung.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => page.evaluate(() => window.__decisionCalls), { timeout: 5_000 }).toEqual(expect.arrayContaining(['/api/docqa/review']));
  expect(await page.evaluate(() => window.__decisionCalls)).toContain('/api/docqa/review-baseline');
  holdOpen = false;
  for (const request of hung.splice(0)) await request.abort().catch(() => {});
});

// A decision with a base that the queue has started (base on its way, review
// not yet sent) loses nothing when the page goes away: pagehide sends its
// review at once. The page's own fetch is wrapped, so nothing reaches the
// shared fixture: the base never answers, as in a page that is gone.
test('@smoke review flow pagehide sends the review of a decision whose base is on its way', async ({ page }) => {
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  const start = page.locator('[data-review-flow-panel="start"]');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();
  const bar = await reachSameProjectPair(page);
  await page.evaluate(() => {
    window.__decisionCalls = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, window.location.href).pathname;
      if (url === '/api/docqa/review-baseline' || url === '/api/docqa/review') {
        window.__decisionCalls.push(url);
        return url.endsWith('baseline') ? new Promise(() => {}) : Promise.reject(new TypeError('page gone'));
      }
      return realFetch(input, init);
    };
    state.externalChange = { source: 'review', path: state.selected, diskHash: state.savedHash, diskContent: state.saved + '\nAdded outside.\n', baseContent: state.saved, reviewDecisions: {} };
    void decideReviewFlow('accept');
  });
  // The next file opens, then the queue sends the base, which never answers.
  await expect(bar).toContainText(/^4 of \d+/, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__decisionCalls), { timeout: 30_000 }).toEqual(['/api/docqa/review-baseline']);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => page.evaluate(() => window.__decisionCalls), { timeout: 5_000 }).toEqual(['/api/docqa/review-baseline', '/api/docqa/review']);
  // A second pagehide (back-forward cache) sends nothing twice.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__decisionCalls)).toHaveLength(2);
});

// Moving the flow to another project reloads the page. That load reads the
// reports from the server cache: the full recompute (`?fresh=1`, 1 to 2 s on a
// 500-file queue) is not sent for each project change.
test('@smoke review flow project change reads cached reports, not a full recompute', async ({ page }) => {
  const data = fixture();
  const reports = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/reports') reports.push(url.search);
  });
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  const start = page.locator('[data-review-flow-panel="start"]');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();
  const bar = page.locator('#reviewFlowBar');
  for (const step of [2, 3]) {
    await expect(bar.locator('[data-review-flow="later"]')).toBeEnabled({ timeout: 30_000 });
    await page.keyboard.press('l');
    await expect(bar).toContainText(new RegExp('^' + step + ' of \\d+'), { timeout: 30_000 });
  }
  await expect(bar.locator('[data-review-flow="later"]')).toBeEnabled({ timeout: 30_000 });
  // WebKit has no requestIdleCallback: the reports read leaves after 120 ms.
  await expect.poll(() => page.evaluate(() => !state.backgroundRefreshTimer && !state.backgroundRefreshPendingOptions && !state.reportsRefreshInFlight), { timeout: 15_000 }).toBe(true);
  expect(reports.length).toBeGreaterThan(0);
  expect(reports.filter((search) => search.includes('fresh=1'))).toEqual([]);
  await bar.locator('[data-review-flow="stop"]').click();
});

// "Previous" goes back to the file just decided: the bar says what was
// decided, and a new decision replaces it. The writes are answered here and
// never reach the shared fixture.
test('@smoke review flow previous shows the earlier decision and lets it change', async ({ page }) => {
  const data = fixture();
  const decisions = [];
  for (const route of ['**/api/docqa/review', '**/api/docqa/review-baseline']) {
    await page.route(route, async (request) => {
      decisions.push(JSON.parse(request.request().postData() || '{}').status);
      await request.fulfill({ json: { ok: true } });
    });
  }
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  const start = page.locator('[data-review-flow-panel="start"]');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();
  const bar = await reachSameProjectPair(page);
  await page.keyboard.press('a');
  await expect(bar).toContainText(/^4 of \d+/, { timeout: 30_000 });
  await expect.poll(async () => Object.values(await flowResults(page)), { timeout: 30_000 }).toContain('accepted');

  const previous = bar.locator('[data-review-flow="previous"]');
  await expect(previous).toBeEnabled();
  expect((await previous.boundingBox()).height).toBeGreaterThanOrEqual(48);
  await page.keyboard.press('p');
  await expect(bar).toContainText(/^3 of \d+/, { timeout: 30_000 });
  await expect(bar.locator('.review-flow-decided')).toContainText('You accepted this file.');
  // "Next" moves on and keeps the decision.
  await expect(bar.locator('[data-review-flow="later"]')).toContainText('Next');
  await page.keyboard.press('l');
  await expect(bar).toContainText(/^4 of \d+/, { timeout: 30_000 });
  // Files 1 and 2 were left for later; file 3 keeps its acceptance.
  expect(Object.values(await flowResults(page)).sort()).toEqual(['accepted', 'later', 'later']);

  // Back twice, to file 2 left for later: Accept replaces "later".
  await bar.locator('[data-review-flow="previous"]').click();
  await expect(bar).toContainText(/^3 of \d+/, { timeout: 30_000 });
  await bar.locator('[data-review-flow="previous"]').click();
  await expect(bar).toContainText(/^2 of \d+/, { timeout: 30_000 });
  await expect(bar.locator('[data-review-flow="accept"]')).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press('a');
  await expect(bar).toContainText(/^3 of \d+/, { timeout: 30_000 });
  await expect.poll(async () => Object.values(await flowResults(page)).sort(), { timeout: 30_000 }).toEqual(['accepted', 'accepted', 'later']);
  // The base request (first review) carries no status.
  expect(decisions.filter(Boolean)).toEqual(['verified', 'verified']);
  await bar.locator('[data-review-flow="stop"]').click();
});

// Coming back to the window (focus, page restore) reads the reports from the
// server cache, which writes, the file watcher and its TTL keep current. The
// full recompute (`?fresh=1`, 1 to 2 s on a 500-file queue) is not sent again.
test('@smoke review flow focus refreshes reports without a full recompute', async ({ page }) => {
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  const start = page.locator('[data-review-flow-panel="start"]');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();
  const bar = page.locator('#reviewFlowBar');
  await expect(bar.locator('[data-review-flow="later"]')).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press('l');
  await expect(bar).toContainText(/^2 of \d+/, { timeout: 30_000 });
  await expect(bar.locator('[data-review-flow="later"]')).toBeEnabled({ timeout: 30_000 });
  // "Later" opened the next item in another project. That open queues its own
  // reports read (loadFiles), sent on an idle callback, or after 120 ms where
  // requestIdleCallback is missing (WebKit). Let it leave before the focus rounds.
  await expect.poll(() => page.evaluate(() => !state.backgroundRefreshTimer && !state.backgroundRefreshPendingOptions && !state.reportsRefreshInFlight), { timeout: 15_000 }).toBe(true);

  const reports = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/reports') reports.push(url.search);
  });
  for (let round = 0; round < 3; round += 1) {
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(400);
  }
  await expect.poll(() => reports.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(reports.filter((search) => search.includes('fresh=1'))).toEqual([]);
  await bar.locator('[data-review-flow="stop"]').click();
});

// A checks run dropped for a newer file (another tab, say) is asked once more,
// then the box says the checks were skipped: never an empty box with no note.
test('@smoke review flow shows skipped documentation checks instead of an empty box', async ({ page }) => {
  const data = fixture();
  const checkCalls = [];
  await page.route('**/api/docqa/document-checks?*', async (route) => {
    checkCalls.push(new URL(route.request().url()).searchParams.get('path'));
    await route.fulfill({ json: { documentChecks: [], documentChecksSuperseded: true } });
  });
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  const start = page.locator('[data-review-flow-panel="start"]');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();
  const bar = page.locator('#reviewFlowBar');
  await expect(bar.locator('[data-review-flow="later"]')).toBeEnabled({ timeout: 30_000 });
  // The shown file carries a review whose checks are still running.
  await page.evaluate(() => {
    state.externalChange = { source: 'review', path: state.selected, diskHash: state.savedHash, diskContent: state.saved + '\nAdded outside.\n', baseContent: state.saved, documentChecks: [], reviewDecisions: {} };
    fillPendingReviewDocumentChecks(state.externalChange);
  });
  await expect.poll(() => page.evaluate(() => (state.externalChange?.documentChecks || []).map((item) => item.type)), { timeout: 15_000 }).toEqual(['checks_unavailable']);
  expect(checkCalls).toHaveLength(2);
  expect(await page.evaluate(() => reviewDocumentChecksMarkup(state.externalChange.documentChecks))).toContain('skipped');
  await page.evaluate(() => { state.externalChange = null; });
  await bar.locator('[data-review-flow="stop"]').click();
});
