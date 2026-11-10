import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultHomePrefs, normalizeHomePrefs, homeEntryType, sortHomeEntries, filterHomeEntries, countHomeTypes, groupHomeProjects, isInternalProject, reviewTotal, distinctWhere, summarizeInspection, formatBytes, formatTokens } from '../src/ui/explorer-view.mjs';
import { NOTEBOOK_WEB_ASSETS } from '../src/notebook_web_assets.mjs';

const f = (name, extra = {}) => ({ name, type: 'file', ...extra });
const d = name => ({ name, type: 'directory' });

test('homeEntryType maps extensions', () => {
  assert.equal(homeEntryType(d('x')), 'folder');
  assert.equal(homeEntryType(f('a.MD')), 'md');
  assert.equal(homeEntryType(f('a.html')), 'html');
  assert.equal(homeEntryType(f('a.crnb')), 'crnb');
  assert.equal(homeEntryType(f('a.png')), 'image');
  assert.equal(homeEntryType(f('a.json')), 'other');
});

test('sort puts folders first and filter keeps folders', () => {
  const list = [f('b.md'), d('z'), f('a.html')];
  assert.deepEqual(sortHomeEntries(list).map(e => e.name), ['z', 'a.html', 'b.md']);
  assert.deepEqual(filterHomeEntries(list, 'md').map(e => e.name), ['b.md', 'z']);
  assert.equal(filterHomeEntries(list, 'all').length, 3);
  assert.ok(countHomeTypes(list));
});

test('groupHomeProjects separates pinned, main, shared, hidden', () => {
  const projects = [
    { projectKey: 'a', title: 'A', root: '/a' },
    { projectKey: 'b', title: 'B', root: '/b' },
    { projectKey: 'c', title: 'C', root: '/c' },
    { projectKey: 's', title: 'S', root: false, mode: 'shared' },
  ];
  const prefs = { ...defaultHomePrefs(), pinned: ['b'], hidden: ['c'] };
  const g = groupHomeProjects(projects, prefs);
  assert.deepEqual(g.pinned.map(p => p.projectKey), ['b']);
  assert.deepEqual(g.main.map(p => p.projectKey), ['a']);
  assert.deepEqual(g.hidden.map(p => p.projectKey), ['c']);
  assert.deepEqual(g.shared.map(p => p.projectKey), ['s']);
});

test('normalizeHomePrefs tolerates junk and module is served', () => {
  const p = normalizeHomePrefs({ pinned: 'x', type: 'nope' });
  assert.ok(Array.isArray(p.pinned) && Array.isArray(p.hidden));
  assert.ok(NOTEBOOK_WEB_ASSETS.has('/assets/ui/explorer-view.mjs'));
});

test('internal Hub folder is hidden unless asked', () => {
  const hub = { projectKey: 'h', title: 'Context Room Hub', root: '/home/u/.context-room/hub/host' };
  const a = { projectKey: 'a', title: 'A', root: '/a' };
  assert.equal(isInternalProject(hub), true);
  assert.equal(isInternalProject(a), false);
  assert.deepEqual(groupHomeProjects([hub, a], defaultHomePrefs()).main.map(p => p.projectKey), ['a']);
  assert.deepEqual(groupHomeProjects([hub, a], { ...defaultHomePrefs(), showInternal: true }).main.map(p => p.projectKey).sort(), ['a', 'h']);
});

test('reviewTotal adds local and shared counts', () => {
  assert.equal(reviewTotal({ localReviewCount: 2, sharedProposalCount: 3 }), 5);
  assert.equal(reviewTotal({}), 0);
});

test('distinctWhere hides a location that repeats the title', () => {
  assert.equal(distinctWhere('goalong.ai', '/x/goalong.ai'), '');
  assert.equal(distinctWhere('Notes', '/x/other'), '/x/other');
});

test('summarizeInspection reads the existing inspection payload', () => {
  assert.equal(summarizeInspection(null), null);
  const s = summarizeInspection({
    doctor: { docqa: { totalDocs: 10, changedDocs: 2, needsReview: 1 }, graph: { stale: 1 } },
    startupContext: [{ startupContext: { fileName: 'AGENTS.md' } }, { startupContext: { fileName: 'AGENTS.md' } }],
    effectiveContext: { cost: { startup: { tokens: 1500 } }, freshness: { state: 'fresh' } },
  });
  assert.deepEqual(s, { names: ['AGENTS.md'], tokens: 1500, total: 10, stale: 3, review: 1, trust: false, state: 'fresh' });
  // F31: a project with no accepted version offers the gesture instead of "all up to date".
  const fresh = summarizeInspection({ doctor: { docqa: { totalDocs: 84, changedDocs: 0, needsReview: 84, trustCurrent: { offered: true } } } });
  assert.equal(fresh.trust, true);
  assert.equal(fresh.review, 84);
  assert.equal(summarizeInspection({ doctor: { docqa: { totalDocs: 84, needsReview: 84, trustCurrent: { offered: false } } } }).trust, false);
});

test('formatters', () => {
  assert.equal(formatBytes(0), 'File');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(12), '12 B');
  assert.equal(formatTokens(1500), '~1.5k tokens');
  assert.equal(formatTokens(300), '~300 tokens');
});
