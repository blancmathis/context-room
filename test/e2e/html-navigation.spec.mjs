import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

test('HTML relative file links navigate through Context Room while executable links stay inert', async ({ page }) => {
  const data = JSON.parse(fs.readFileSync(process.env.CONTEXT_ROOM_E2E_FIXTURE, 'utf8'));
  const project = data.projects.atlas;
  fs.writeFileSync(path.join(project.root, 'docs/link-probe.html'), '<!doctype html><html><body><a href="README.md">Open sibling document</a><a href="javascript:alert(1)">Unsafe link</a><script>parent.__unsafeHtmlExecuted=true</script></body></html>');
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(project.id)}&view=file&file=docs%2Flink-probe.html`);
  const preview = page.frameLocator('iframe.html-preview-frame');
  await expect(preview.getByRole('link', { name: 'Open sibling document' })).toBeVisible();
  await expect(preview.locator('a', { hasText: 'Unsafe link' })).not.toHaveAttribute('href', /./);
  expect(await page.evaluate(() => Boolean(globalThis.__unsafeHtmlExecuted))).toBe(false);
  // Even if an author script escaped sanitization, the frame CSP must deny it.
  await page.locator('iframe.html-preview-frame').evaluate(frame => { const script=frame.contentDocument.createElement('script'); script.textContent='parent.__unsafeHtmlExecuted=true'; frame.contentDocument.body.append(script); });
  expect(await page.evaluate(() => Boolean(globalThis.__unsafeHtmlExecuted))).toBe(false);
  await preview.getByRole('link', { name: 'Open sibling document' }).click();
  await expect.poll(() => page.evaluate(() => state.selected)).toBe('docs/README.md');
  await expect(page.locator('iframe.html-preview-frame')).toHaveCount(0);
});
