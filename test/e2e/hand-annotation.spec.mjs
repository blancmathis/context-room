import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { assistantFixture } from '../fixtures/assistant.mjs';
import { codexToolContent } from '../../src/assistant_observations.mjs';
import { readLocalProposalFile } from '../../src/local_proposals.mjs';
import { writeDocReviewDecision } from '../../src/context_room.mjs';

test('@smoke @assistant a hand annotation sends its exact passage and snapshot, and the agent replaces only that passage', async ({ page }, testInfo) => {
  const f = await assistantFixture(), file = path.join(f.root, 'docs/Original.md');
  const text = '# Original document\n\n## Été\n\nSame paragraph.\n\nSame paragraph.\n\nLast — line.\n';
  fs.writeFileSync(file, text); writeDocReviewDecision(f.root, 'docs/Original.md', { status: 'verified' });
  const created = []; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/assistant/conversations')) created.push(request.postDataJSON()); });
  const open = async () => {
    await page.goto(f.url); await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile('docs/Original.md')); await expect(page.locator('#docReader .markdown-line[data-line-index="6"]')).toBeVisible();
  };
  try {
    await open();
    await page.getByRole('button', { name: 'Annotate', exact: true }).click();
    const bar = page.getByRole('toolbar', { name: 'Annotation' }), status = bar.getByRole('status');
    await expect(status).toContainText('Draw over a passage'); await expect(bar.getByRole('button', { name: 'Discuss this annotation' })).toBeDisabled();
    const box = await page.locator('#docReader .markdown-line[data-line-index="6"]').boundingBox();
    await page.mouse.move(box.x + 4, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + 2, { steps: 6 }); await page.mouse.move(box.x + 160, box.y + box.height - 2, { steps: 6 }); await page.mouse.up();
    await expect(status).toContainText('Line 7 selected.'); await expect(page.locator('#docReader .hand-annotation-line')).toHaveCount(1);
    await expect(bar.getByRole('button', { name: 'Discuss this annotation' })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('hand-annotation.png') });

    await open(); await page.getByRole('button', { name: 'Annotate', exact: true }).click();
    await expect(status).toContainText('Line 7 selected.', { timeout: 5000 });
    await bar.getByRole('button', { name: 'Discuss this annotation' }).click();
    const pane = page.getByRole('complementary', { name: 'Original document conversation' });
    await expect(pane).toHaveAttribute('data-ready', 'true'); await expect(bar).toHaveCount(0);
    const sent = created.at(-1).source, start = text.lastIndexOf('Same paragraph.');
    expect(sent.selection).toEqual({ start, end: start + 15, text: 'Same paragraph.' }); expect(sent.annotation.section).toBe('Original document › Été');
    expect(sent.annotation.image.slice(0, 22)).toBe('data:image/png;base64,');
    fs.writeFileSync(testInfo.outputPath('annotation-snapshot.png'), Buffer.from(sent.annotation.image.split(',')[1], 'base64'));
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('context-room-hand-annotation:')))).toEqual([]);

    await pane.getByRole('textbox').fill('Simplify this.'); await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(1);
    const turn = f.turns[0], options = { callId: 'see', turnId: turn.turnId, signal: new AbortController().signal };
    const seen = await turn.tool('context_room_document', { action: 'annotation' }, options);
    expect(seen.valid).toBe(true); expect(codexToolContent(seen)[1].imageUrl).toBe(sent.annotation.image);
    const result = await turn.tool('context_room_document', { action: 'replace_annotation', annotationId: seen.annotationId, replacement: 'One clear line.' }, { ...options, callId: 'replace' });
    expect(readLocalProposalFile(f.root, result.proposalId, 'docs/Original.md').afterBytes.toString()).toBe(text.slice(0, start) + 'One clear line.' + text.slice(start + 15));
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    f.finish('done');
  } finally { try { if (!page.isClosed()) await page.goto('about:blank'); } finally { await f.close(); } }
});
