import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultHomePrefs, normalizeHomePrefs, homeEntryType, sortHomeEntries, filterHomeEntries, countHomeTypes, groupHomeProjects } from '../src/ui/home-layouts.mjs';
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
  assert.ok(NOTEBOOK_WEB_ASSETS.has('/assets/ui/home-layouts.mjs'));
});
