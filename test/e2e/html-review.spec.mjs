import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { initializeContextRoomProject } from '../../src/context_room.mjs';
import { registerContextHubProject, unregisterContextHubProject } from '../../src/context_hub.mjs';

// T-html-diff: a changed HTML page is reviewed as a page. Each test opens its own file, then sets the review
// (accepted version, new version, kind) the way applyChangedFileInlineReview does, and renders the viewer.
const page = (body, style = '') => `<!doctype html><html><head><style>${style}</style></head><body>${body}</body></html>`;
const section = (title, ...paragraphs) => `<h2>${title}</h2>` + paragraphs.map((text) => `<p>${text}</p>`).join('');

async function openReview(browserPage, testInfo, { before, after, kind = 'modified' }) {
  const data = JSON.parse(fs.readFileSync(process.env.CONTEXT_ROOM_E2E_FIXTURE, 'utf8'));
  const project = data.projects.atlas;
  const file = `docs/visual-review-${testInfo.project.name}-${testInfo.title.replace(/\W+/g, '-').slice(0, 40)}-${kind}.html`;
  fs.writeFileSync(path.join(project.root, file), after || before);
  await browserPage.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(project.id)}&view=file&file=${encodeURIComponent(file)}`);
  // The new file opens as a real « new page » review first; wait for it, then stage the review under test.
  await browserPage.waitForFunction((file) => state.externalChange?.path === file && !state.openingFilePath, file, { timeout: 30_000 });
  await browserPage.evaluate(({ file, before, after, kind }) => {
    state.externalChange = { path: file, source: 'review', baseContent: before, diskContent: after, diskHash: '', diskUpdatedAt: '', changeKind: kind, documentChecks: [], reviewDecisions: {} };
    state.diffCollapsed = true;
    // The disk check would see the file unchanged and close this staged review: no saved hash, no check.
    state.savedHash = null;
    renderViewer();
  }, { file, before, after, kind });
  await expect(browserPage.locator('.crh-bar')).toBeVisible();
  return browserPage.frameLocator('iframe.html-preview-frame');
}

test('a small change is framed in the page, a tap shows the earlier text, N steps through changes', async ({ page: browserPage }, testInfo) => {
  const frame = await openReview(browserPage, testInfo, {
    before: page(section('Intro', 'First line.', 'Second line.', 'Third line.', 'Fourth line.')),
    after: page(section('Intro', 'First line.', 'Second line, edited.', 'Third line.', 'Fourth line.')),
  });
  await expect(browserPage.locator('[data-crh-note]')).toHaveText('1 change');
  await expect(frame.locator('.cr-box.changed .cr-tag')).toContainText('Changed');
  // The Git diff stays folded for a page.
  await expect(browserPage.locator('.review-workspace.no-diff')).toHaveCount(1);
  const edited = frame.getByText('Second line, edited.');
  await edited.click();
  await expect(frame.locator('.cr-was')).toHaveText('Second line.');
  await expect(edited).toBeHidden();
  await expect(frame.locator('.cr-tag')).toHaveText('Before');
  await frame.locator('.cr-was').click();
  await expect(edited).toBeVisible();
  await expect(frame.locator('.cr-was')).toHaveCount(0);
  await browserPage.locator('body').press('n');
  await expect(browserPage.locator('[data-crh-count]')).toHaveText('1 / 1');
  await expect(frame.locator('.cr-box.cur')).toHaveCount(1);
  // Targets of 44 px at least.
  for (const box of await browserPage.locator('.crh-bar button:visible').evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
});

test('a rewritten section is one frame and a removed block leaves one line', async ({ page: browserPage }, testInfo) => {
  const frame = await openReview(browserPage, testInfo, {
    before: page(section('Intro', 'Kept text.') + section('Plan', 'Old one.', 'Old two.', 'Old three.') + section('Notes', 'Note A.', 'Note B.', 'Note C.', 'Note D.')),
    after: page(section('Intro', 'Kept text.') + section('Plan', 'New one.', 'New two.', 'New three.') + section('Notes', 'Note A.', 'Note C.', 'Note D.')),
  });
  await expect(frame.locator('.cr-box.rewritten')).toHaveCount(1);
  await expect(frame.locator('.cr-box.changed')).toHaveCount(0);
  await expect(frame.locator('.cr-gone')).toHaveText('1 block removed');
  await expect(browserPage.locator('[data-crh-note]')).toHaveText('2 changes');
  // A tap on the rewritten section shows the whole earlier section in place.
  await frame.getByText('New two.').click();
  await expect(frame.locator('.cr-was')).toHaveText(['Plan', 'Old one.', 'Old two.', 'Old three.']);
  await frame.locator('.cr-gone').click();
  await expect(frame.locator('.cr-was').last()).toHaveText('Note B.');
});

test('Before | After switches the whole page and keeps the same block in view', async ({ page: browserPage }, testInfo) => {
  const parts = (word) => Array.from({ length: 40 }, (_, i) => section('Part ' + i, `${i === 30 ? word : 'Same'} body ${i}.`, 'Filler text.', 'More filler.')).join('');
  const frame = await openReview(browserPage, testInfo, { before: page(parts('Old')), after: page(parts('New')) });
  await frame.getByRole('heading', { name: 'Part 25' }).evaluate((heading) => heading.scrollIntoView());
  const before = browserPage.frameLocator('iframe.crh-old');
  await browserPage.locator('body').press('b');
  await expect(browserPage.locator('[data-crh-mode="before"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(browserPage.locator('iframe.crh-old')).toBeVisible();
  await expect(browserPage.locator('iframe.html-preview-frame')).toBeHidden();
  const top = await before.locator('h2').evaluateAll((headings) => headings.find((h) => h.getBoundingClientRect().bottom > 0)?.textContent);
  expect(top).toBe('Part 25');
  await browserPage.locator('[data-crh-mode="after"]').click();
  await expect(browserPage.locator('iframe.html-preview-frame')).toBeVisible();
  await expect(frame.getByText('Old body 30.')).toHaveCount(0);
  await expect(before.getByText('Old body 30.')).toHaveCount(1);
});

test('a deleted section is one « blocks removed » line, not a Rewritten frame on the next section', async ({ page: browserPage }, testInfo) => {
  const frame = await openReview(browserPage, testInfo, {
    before: page(section('Intro', 'Kept text.') + section('Gone', 'G1.', 'G2.', 'G3.', 'G4.') + section('Keep', 'K1.', 'K2.')),
    after: page(section('Intro', 'Kept text.') + section('Keep', 'K1.', 'K2.')),
  });
  await expect(browserPage.locator('[data-crh-note]')).toHaveText('1 change');
  await expect(frame.locator('.cr-gone')).toHaveText('5 blocks removed');
  await expect(frame.locator('.cr-box.rewritten')).toHaveCount(0);
});

test('a style-only change says so and Before | After keeps the place', async ({ page: browserPage }, testInfo) => {
  const body = Array.from({ length: 30 }, (_, i) => section('Look ' + i, 'Same words.', 'More words.')).join('');
  const frame = await openReview(browserPage, testInfo, { before: page(body, 'h2{color:#111}'), after: page(body, 'h2{color:#999}') });
  await expect(browserPage.locator('[data-crh-note]')).toHaveText('Style changed');
  await expect(browserPage.locator('[data-crh-mode="before"]')).toBeVisible();
  await expect(frame.locator('.cr-box')).toHaveCount(0);
  await frame.getByRole('heading', { name: 'Look 22' }).evaluate((heading) => heading.scrollIntoView());
  await browserPage.locator('[data-crh-mode="before"]').click();
  const top = await browserPage.frameLocator('iframe.crh-old').locator('h2').evaluateAll((headings) => headings.find((h) => h.getBoundingClientRect().bottom > 1)?.textContent);
  expect(top).toBe('Look 22');
});

test('a new page shows whole, and a deleted page shows its last version', async ({ page: browserPage }, testInfo) => {
  let frame = await openReview(browserPage, testInfo, { before: '', after: page(section('Fresh', 'Brand new page.')), kind: 'added' });
  await expect(browserPage.locator('[data-crh-note]')).toHaveText('New page');
  await expect(browserPage.locator('[data-crh-mode]')).toHaveCount(0);
  await expect(frame.getByText('Brand new page.')).toBeVisible();
  await expect(frame.locator('.cr-box')).toHaveCount(0);
  frame = await openReview(browserPage, testInfo, { before: page(section('Gone', 'Old page text.')), after: '', kind: 'deleted' });
  await expect(browserPage.locator('[data-crh-note]')).toHaveText('Page deleted');
  await expect(frame.getByText('Old page text.')).toBeVisible();
});

// The real flow (no staged review): a committed page is changed and another is deleted on disk, and both open
// from « To review ». A new render of the viewer (what a background refresh does) keeps the tap and the place.
test('the real Git flow opens a changed page and a deleted page from To review', async ({ page: browserPage }, testInfo) => {
  const data = JSON.parse(fs.readFileSync(process.env.CONTEXT_ROOM_E2E_FIXTURE, 'utf8'));
  const title = `Pages ${testInfo.project.name} ${testInfo.retry}`;
  const root = path.join(data.base, title.replace(/\W+/g, '-'));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const parts = (word) => Array.from({ length: 30 }, (_, i) => section('Part ' + i, `${i === 20 ? word : 'Same'} body ${i}.`, 'Filler text.')).join('');
  fs.writeFileSync(path.join(root, 'docs', 'page.html'), page(parts('Old')));
  fs.writeFileSync(path.join(root, 'docs', 'gone.html'), page(section('Gone', 'Old page text.')));
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'pages@example.test']);
  git(['config', 'user.name', 'Pages Test']);
  initializeContextRoomProject(root, { title, allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  git(['add', '.']);
  git(['commit', '-m', 'Initial']);
  fs.writeFileSync(path.join(root, 'docs', 'page.html'), page(parts('New')));
  fs.rmSync(path.join(root, 'docs', 'gone.html'));
  const projectId = registerContextHubProject(root, { title }).id;
  // A click on the row in « To review »; a row past the sample the queue shows runs the same open path.
  const openFromQueue = async (file) => {
    await browserPage.goto(`${data.origin}/?hub=1&view=hub`);
    await browserPage.waitForFunction(() => state.contextHubReviewQueueReady === true, null, { timeout: 30_000 });
    let id = '';
    await expect.poll(async () => id = await browserPage.evaluate(({ projectId, file }) => contextHubReviewItems()
      .find((item) => item.projectId === projectId && (item.localReview?.path || item.localFile) === file)?.id || '', { projectId, file }), { timeout: 30_000 }).not.toBe('');
    const row = browserPage.locator('#reviewQueue [data-context-room-review=' + JSON.stringify(id) + ']');
    if (await row.count()) await row.first().click();
    else await browserPage.evaluate((id) => {
      const item = contextHubReviewItems().find((candidate) => candidate.id === id);
      if (!startReviewFlow(id)) openContextHubProject(item.projectId, { reviewTarget: item.localReview || { path: item.localFile } });
    }, id);
    await expect(browserPage.locator('.crh-bar')).toBeVisible({ timeout: 30_000 });
    return browserPage.frameLocator('iframe.html-preview-frame');
  };
  const topHeading = (frame) => frame.locator('h2').evaluateAll((headings) => headings.find((h) => h.getBoundingClientRect().bottom > 1)?.textContent);
  try {
    const frame = await openFromQueue('docs/page.html');
    expect(await browserPage.evaluate(() => state.externalChange?.changeKind)).toBe('modified');
    await expect(browserPage.locator('[data-crh-note]')).toHaveText('1 change');
    await expect(frame.locator('.cr-box.changed')).toHaveCount(1);
    await frame.getByText('New body 20.').click();
    await expect(frame.locator('.cr-was')).toHaveText('Old body 20.');
    await frame.getByRole('heading', { name: 'Part 18' }).evaluate((heading) => heading.scrollIntoView());
    await expect.poll(() => topHeading(frame)).toBe('Part 18');
    await browserPage.locator('iframe.html-preview-frame').evaluate((iframe) => iframe.dataset.earlierRender = '');
    await browserPage.evaluate(() => renderViewer());
    await expect(browserPage.locator('iframe.html-preview-frame[data-earlier-render]')).toHaveCount(0);
    await expect(frame.locator('.cr-was')).toHaveText('Old body 20.');
    await expect(frame.getByText('New body 20.')).toBeHidden();
    await expect.poll(() => topHeading(frame)).toBe('Part 18');
    // Before | After still keeps the place after the new render.
    await browserPage.locator('[data-crh-mode="before"]').click();
    await expect.poll(() => topHeading(browserPage.frameLocator('iframe.crh-old'))).toBe('Part 18');

    const deleted = await openFromQueue('docs/gone.html');
    expect(await browserPage.evaluate(() => state.externalChange?.changeKind)).toBe('deleted');
    await expect(browserPage.locator('[data-crh-note]')).toHaveText('Page deleted');
    await expect(deleted.getByText('Old page text.')).toBeVisible();
  } finally {
    unregisterContextHubProject(root);
  }
});
