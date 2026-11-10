import fs from 'node:fs';
import { test, expect } from '@playwright/test';

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error('Missing Context Room UX fixture');
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
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
  const bar = page.locator('#reviewFlowBar');
  await expect(bar).toContainText(/^1 of \d+/, { timeout: 30_000 });
  const accept = bar.locator('[data-review-flow="accept"]');
  await expect(accept).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press('a');
  await expect(bar).toContainText(/^2 of \d+/, { timeout: 30_000 });

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
