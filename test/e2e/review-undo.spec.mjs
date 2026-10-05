import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { initializeContextRoomProject, writeDocReviewDecision } from '../../src/context_room.mjs';
import { registerContextHubProject, unregisterContextHubProject } from '../../src/context_hub.mjs';

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error('Missing Context Room UX fixture');
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

test('@smoke an acceptance can be undone from Recent decisions and the file goes back to review', async ({ page }, testInfo) => {
  const data = fixture();
  const root = path.join(data.base, `Undo-${testInfo.project.name}`);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'README.md'), '# Undo\n', 'utf8');
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'undo@example.test']);
  git(['config', 'user.name', 'Undo Test']);
  initializeContextRoomProject(root, { title: `Undo ${testInfo.project.name}`, allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  git(['add', '.']);
  git(['commit', '-m', 'Initial']);
  fs.appendFileSync(path.join(root, 'docs', 'README.md'), '\nAccepted from the queue.\n', 'utf8');
  writeDocReviewDecision(root, 'docs/README.md', { status: 'verified', receiptSource: 'hub-queue' });
  registerContextHubProject(root, { title: `Undo ${testInfo.project.name}` });

  try {
    await page.goto(`${data.origin}/?hub=1&view=hub`);
    const panel = page.locator('#reviewHistoryPanel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await panel.locator('summary').click();
    const row = panel.locator('li', { hasText: `Undo ${testInfo.project.name}` }).filter({ hasText: 'Accepted' });
    await row.getByRole('button', { name: 'Undo this acceptance' }).click();
    const dialog = page.getByRole('dialog', { name: 'Undo this acceptance?' });
    await expect(dialog).toContainText('The file is not restored');
    await dialog.getByRole('button', { name: 'Undo acceptance' }).click();
    await expect(panel.locator('li', { hasText: `Undo ${testInfo.project.name}` }).first()).toContainText('Acceptance undone', { timeout: 30_000 });
    await expect(row.getByRole('button', { name: 'Undo this acceptance' })).toHaveCount(0);
    expect(fs.readFileSync(path.join(root, 'docs', 'README.md'), 'utf8')).toContain('Accepted from the queue.');
  } finally {
    unregisterContextHubProject(root);
  }
});
