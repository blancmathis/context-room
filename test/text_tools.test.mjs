import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTEBOOK_WEB_ASSETS } from '../src/notebook_web_assets.mjs';
import { foldForSearch, findMatches, replaceAllText, contentsPage, createTextHistory } from '../src/ui/text-tools.mjs';

test('foldForSearch keeps the length and folds case and accents', () => {
  assert.equal(foldForSearch('Mémo É'), 'memo e');
  const odd = 'İ 😀 ß';
  assert.equal(foldForSearch(odd).length, odd.length);
  assert.equal(foldForSearch(odd), 'i 😀 ß');
  for (const text of ['Éléphant à Paris', 'ÀÉÎÕÜ ǅ ﬁ', 'école']) assert.equal(foldForSearch(text).length, text.length);
});

test('findMatches finds memo in Mémo unless exact mode is on', () => {
  assert.deepEqual(findMatches('Un Mémo, un MEMO.', 'memo').starts, [3, 12]);
  assert.equal(findMatches('Un Mémo', 'memo', { exact: true }).starts.length, 0);
  assert.deepEqual(findMatches('Un Mémo', 'Mémo', { exact: true }).starts, [3]);
  assert.equal(findMatches('abc', '').starts.length, 0);
});

test('findMatches stops counting at the bound and reports more', () => {
  const found = findMatches('a'.repeat(50), 'a', { limit: 10 });
  assert.equal(found.starts.length, 10);
  assert.equal(found.more, true);
  assert.equal(findMatches('a'.repeat(10), 'a', { limit: 10 }).more, false);
});

test('replaceAllText replaces 6400 matches in a 1.7 MB text once and counts them', () => {
  const line = 'x'.repeat(250) + ' Mémo ' + 'y'.repeat(10) + '\n';
  const text = line.repeat(6400);
  assert.ok(text.length > 1_700_000);
  const started = Date.now();
  const done = replaceAllText(text, 'memo', 'note');
  assert.equal(done.count, 6400);
  assert.equal(done.text.length, text.length);
  assert.ok(!done.text.includes('Mémo') && done.text.includes(' note '));
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(replaceAllText('abc', 'zz', '1'), { text: 'abc', count: 0 });
});

test('contentsPage pages by 40, opens on the active heading page, filters without accents', () => {
  const entries = Array.from({ length: 20_001 }, (_, index) => ({ text: 'Résumé ' + index, slug: 'resume-' + index }));
  const first = contentsPage(entries);
  assert.equal(first.items.length, 40);
  assert.deepEqual([first.start, first.end, first.total, first.hasPrevious, first.hasNext], [0, 40, 20001, false, true]);
  const opened = contentsPage(entries, { active: 12_345 });
  assert.equal(opened.start, 12_320);
  assert.ok(opened.items.some((item) => item.index === 12_345));
  const last = contentsPage(entries, { start: 99_999 });
  assert.deepEqual([last.start, last.end, last.items.length, last.hasNext], [20_000, 20_001, 1, false]);
  const found = contentsPage(entries, { query: 'resume 19999' });
  assert.deepEqual(found.items.map((item) => item.index), [19_999]);
  assert.equal(found.total, 1);
  const none = contentsPage(entries, { query: 'zzz' });
  assert.deepEqual([none.items.length, none.total, none.start, none.hasNext], [0, 0, 0, false]);
  const filtered = contentsPage(entries, { query: 'RÉSUMÉ 1', active: 10_000 });
  assert.ok(filtered.items.some((item) => item.index === 10_000));
});

test('createTextHistory drops the oldest snapshots past maxChars and keeps redo', () => {
  const history = createTextHistory({ maxChars: 100 });
  history.push('a'.repeat(40));
  history.push('b'.repeat(40));
  history.push('c'.repeat(40));
  assert.equal(history.steps, 2);
  assert.ok(history.chars <= 100);
  assert.equal(history.undo('d'.repeat(10)), 'c'.repeat(40));
  assert.equal(history.canRedo, true);
  assert.equal(history.redo('c'.repeat(40)), 'd'.repeat(10));
  history.undo('e');
  history.push('f');
  assert.equal(history.canRedo, false);
  assert.equal(createTextHistory().undo('x'), null);
});

test('the text-tools module is served as JavaScript', () => {
  const asset = NOTEBOOK_WEB_ASSETS.get('/assets/ui/text-tools.mjs');
  assert.equal(asset.file, 'ui/text-tools.mjs');
  assert.match(asset.type, /javascript/);
});
