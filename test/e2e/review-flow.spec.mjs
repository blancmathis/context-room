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
