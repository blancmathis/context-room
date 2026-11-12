import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeProjectPage, defaultProjectTiles, moveProjectTile, removeProjectTile, addProjectTile, sizeProjectTile, projectTileKey,
} from '../src/ui/project-page.mjs';
import { readProjectPage, writeProjectPage, projectPagesPath } from '../src/context_room.mjs';

const keys = (tiles) => tiles.map(projectTileKey);

test('the default project page starts with the agent files, then the top-level folders; Recent docs is opt-in', () => {
  assert.deepEqual(keys(defaultProjectTiles(['docs', 'brand'])), ['agents', 'folder:docs', 'folder:brand']);
  assert.equal(defaultProjectTiles(['docs'])[1].size, 'half');
  assert.ok(!keys(defaultProjectTiles(['docs'])).includes('recent'));
});

test('normalize drops unknown tiles, unsafe paths and repeats; no list means the default, an empty list is a choice', () => {
  const page = normalizeProjectPage({ tiles: [
    { type: 'folder', path: 'docs/' }, { type: 'folder', path: 'docs' }, { type: 'nope' }, null,
    { type: 'file', path: '../secret.md' }, { type: 'file', path: 'docs/./a.md' }, { type: 'file' }, { type: 'agents', size: 'half' },
  ] });
  assert.deepEqual(page.tiles, [{ type: 'folder', size: 'full', path: 'docs' }, { type: 'agents', size: 'half' }]);
  assert.deepEqual(normalizeProjectPage({ tiles: [] }).tiles, []);
  assert.equal(normalizeProjectPage({ version: 1 }).tiles, null);
  assert.equal(normalizeProjectPage('x').tiles, null);
  assert.equal(normalizeProjectPage({ tiles: Array.from({ length: 80 }, (_, index) => ({ type: 'file', path: 'f' + index + '.md' })) }).tiles.length, 60);
});

test('each gesture returns a new list and never mutates', () => {
  const start = defaultProjectTiles(['docs', 'brand']);
  const frozen = JSON.stringify(start);
  assert.deepEqual(keys(moveProjectTile(start, 'folder:brand', -1)), ['agents', 'folder:brand', 'folder:docs']);
  assert.equal(moveProjectTile(start, 'agents', -1), start, 'the first tile cannot go up');
  assert.deepEqual(keys(removeProjectTile(start, 'agents')), ['folder:docs', 'folder:brand']);
  const pinned = addProjectTile(start, { type: 'file', path: 'PLAN.md', size: 'half' });
  assert.equal(keys(pinned).at(-1), 'file:PLAN.md');
  assert.equal(addProjectTile(pinned, { type: 'file', path: 'PLAN.md' }), pinned, 'a tile shows once');
  assert.equal(addProjectTile(start, { type: 'file', path: '../secret.md' }), start, 'a path never leaves the project');
  assert.equal(keys(addProjectTile(start, { type: 'file', path: '/notes/a.md' })).at(-1), 'file:notes/a.md', 'a leading slash means the project root');
  assert.equal(sizeProjectTile(start, 'agents')[0].size, 'half');
  assert.equal(JSON.stringify(start), frozen);
});

test('the Hub keeps each project page in project-pages.json next to the preferences, with a revision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-project-page-'));
  try {
    const preferences = path.join(dir, 'preferences.json');
    assert.equal(projectPagesPath(preferences), path.join(dir, 'project-pages.json'));
    const first = readProjectPage('local:a', preferences);
    assert.equal(first.stored, false);
    assert.equal(first.page.tiles, null);
    const written = writeProjectPage('local:a', { tiles: [{ type: 'recent', size: 'half' }] }, preferences, { expectedRevision: first.revision });
    assert.equal(written.stored, true);
    assert.deepEqual(readProjectPage('local:a', preferences), written);
    assert.equal(readProjectPage('local:b', preferences).stored, false, 'each project has its own page');
    assert.equal(fs.statSync(projectPagesPath(preferences)).mode & 0o777, 0o600);
    assert.throws(() => writeProjectPage('local:a', { tiles: [] }, preferences, { expectedRevision: first.revision }), (error) => error.code === 'project_page_stale');
    fs.writeFileSync(projectPagesPath(preferences), '{broken');
    assert.equal(readProjectPage('local:a', preferences).stored, false, 'a damaged file falls back to the default');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a project key such as __proto__ is a plain entry and never changes Object.prototype', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-project-page-'));
  try {
    const preferences = path.join(dir, 'preferences.json');
    writeProjectPage('local:a', { tiles: [{ type: 'all', size: 'full' }] }, preferences);
    const written = writeProjectPage('__proto__', { tiles: [{ type: 'recent', size: 'half' }] }, preferences);
    assert.equal(Object.prototype.tiles, undefined);
    assert.deepEqual(readProjectPage('__proto__', preferences), written);
    assert.equal(readProjectPage('local:a', preferences).page.tiles[0].type, 'all', 'the other pages stay');
    assert.ok(Object.hasOwn(JSON.parse(fs.readFileSync(projectPagesPath(preferences), 'utf8')).projects, '__proto__'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
