import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diffBlocks, REWRITE_MIN_BLOCKS, REWRITE_SHARE } from '../src/ui/html-review.mjs';
import { NOTEBOOK_WEB_ASSETS } from '../src/notebook_web_assets.mjs';

// A block list: [tag, text, section].
const blocks = (rows) => rows.map(([t, text, s = 0]) => ({ t, k: t + '|' + text, s }));
const kinds = (result) => result.units.map((unit) => unit.kind);

test('identical pages have no change', () => {
  const page = blocks([['H1', 'Title', 1], ['P', 'One', 1], ['P', 'Two', 1]]);
  const result = diffBlocks(page, page);
  assert.deepEqual(result.units, []);
  assert.ok(result.ops.every((op) => op.type === 'same'));
});

test('a small edit gives one Changed block at its place', () => {
  const before = blocks([['H1', 'Title', 1], ['P', 'One', 1], ['P', 'Two', 1], ['P', 'Three', 1], ['P', 'Four', 1]]);
  const after = blocks([['H1', 'Title', 1], ['P', 'One', 1], ['P', 'Two, edited', 1], ['P', 'Three', 1], ['P', 'Four', 1]]);
  const result = diffBlocks(before, after);
  assert.deepEqual(kinds(result), ['changed']);
  assert.deepEqual(result.ops[result.units[0].ops[0]], { type: 'changed', a: 2, b: 2 });
});

test('an added block and a removed block keep their place and kind', () => {
  const before = blocks([['H1', 'T', 1], ['P', 'A', 1], ['TABLE', 'grid', 1], ['P', 'B', 1], ['P', 'C', 1], ['P', 'D', 1]]);
  const after = blocks([['H1', 'T', 1], ['P', 'A', 1], ['P', 'B', 1], ['P', 'C', 1], ['IMG', 'new picture', 1], ['P', 'D', 1]]);
  const result = diffBlocks(before, after);
  assert.deepEqual(kinds(result), ['removed', 'added']);
  assert.deepEqual(result.ops.map((op) => op.type), ['same', 'same', 'removed', 'same', 'same', 'added', 'same']);
});

test('removed blocks next to each other are one « blocks removed » line', () => {
  const before = blocks([['H1', 'T', 1], ['P', 'A', 1], ['P', 'B', 1], ['P', 'C', 1], ['P', 'D', 1], ['P', 'E', 1], ['P', 'F', 1], ['P', 'G', 1]]);
  const after = blocks([['H1', 'T', 1], ['P', 'A', 1], ['P', 'D', 1], ['P', 'E', 1], ['P', 'F', 1], ['P', 'G', 1]]);
  const result = diffBlocks(before, after);
  assert.deepEqual(kinds(result), ['removed']);
  assert.equal(result.units[0].ops.length, 2);
});

test(`a section with ${REWRITE_MIN_BLOCKS}+ blocks and ${REWRITE_SHARE * 100} %+ changed is one Rewritten frame`, () => {
  const before = blocks([['H2', 'Intro', 1], ['P', 'Kept', 1], ['H2', 'Plan', 2], ['P', 'Old one', 2], ['P', 'Old two', 2], ['UL', 'old list', 2], ['H2', 'End', 3], ['P', 'Bye', 3]]);
  const after = blocks([['H2', 'Intro', 1], ['P', 'Kept', 1], ['H2', 'Plan', 2], ['P', 'New one', 2], ['P', 'New two', 2], ['UL', 'new list', 2], ['H2', 'End', 3], ['P', 'Bye', 3]]);
  const result = diffBlocks(before, after);
  assert.deepEqual(kinds(result), ['rewritten']);
  // The frame covers the whole section, heading included.
  assert.deepEqual(result.units[0].ops.map((x) => result.ops[x].b), [2, 3, 4, 5]);
});

test('below the share, a section keeps single frames', () => {
  const before = blocks([['H2', 'Plan', 1], ['P', 'One', 1], ['P', 'Two', 1], ['P', 'Three', 1], ['P', 'Four', 1]]);
  const after = blocks([['H2', 'Plan', 1], ['P', 'One!', 1], ['P', 'Two', 1], ['P', 'Three', 1], ['P', 'Four!', 1]]);
  assert.deepEqual(kinds(diffBlocks(before, after)), ['changed', 'changed']);
});

test('a new section of new blocks is one Added frame', () => {
  const before = blocks([['H2', 'Intro', 1], ['P', 'Kept', 1]]);
  const after = blocks([['H2', 'Intro', 1], ['P', 'Kept', 1], ['H2', 'Fresh', 2], ['P', 'x', 2], ['P', 'y', 2]]);
  assert.deepEqual(kinds(diffBlocks(before, after)), ['added']);
});

test('a huge page skips the quadratic table and still marks the middle', () => {
  const before = blocks(Array.from({ length: 2500 }, (_, i) => ['P', 'old ' + i, i]));
  const after = blocks(Array.from({ length: 2500 }, (_, i) => ['P', 'new ' + i, i]));
  const result = diffBlocks(before, after);
  assert.equal(result.units.length, 2500);
  assert.ok(result.units.every((unit) => unit.kind === 'changed'));
});

test('the module is served and loaded on demand from the main script', () => {
  assert.equal(NOTEBOOK_WEB_ASSETS.get('/assets/ui/html-review.mjs')?.file, 'ui/html-review.mjs');
  const app = fs.readFileSync(new URL('../src/ui/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /import\("\/assets\/ui\/html-review\.mjs"\)/);
  assert.match(app, /module\.mount\(root, change, externalReviewBaseContent\(change\), sanitizedHtmlPreviewDocument,/);
});
