import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultHomeConfig, normalizeHomeConfig, moveHomeBlock, removeHomeBlock, addHomeBlock, sizeHomeBlock, hiddenHomeBlocks, HOME_BLOCK_TYPES,
} from '../src/ui/home-config.mjs';
import { readHomeConfig, writeHomeConfig, homeConfigPath } from '../src/context_room.mjs';
import { NOTEBOOK_WEB_ASSETS } from '../src/notebook_web_assets.mjs';

const types = config => config.blocks.map(block => block.type);

test('the default Home starts with projects, then their files', () => {
  const config = defaultHomeConfig();
  assert.deepEqual(types(config).slice(0, 2), ['projects', 'files']);
  assert.deepEqual(hiddenHomeBlocks(config).map(block => block.type), ['documents']);
});

test('normalize drops unknown and repeated blocks, keeps an empty choice, and falls back to the default', () => {
  const messy = normalizeHomeConfig({ blocks: [{ type: 'health', size: 'big' }, { type: 'nope' }, { type: 'health' }, null, { type: 'files', size: 'full' }] });
  assert.deepEqual(messy.blocks, [{ type: 'health', size: 'half' }, { type: 'files', size: 'full' }]);
  assert.deepEqual(normalizeHomeConfig({ blocks: [] }).blocks, []);
  assert.deepEqual(types(normalizeHomeConfig({ version: 1 })), types(defaultHomeConfig()));
  assert.deepEqual(normalizeHomeConfig('x'), defaultHomeConfig());
  assert.equal(normalizeHomeConfig({ prefs: { type: 'zip' } }).prefs.type, 'all');
});

test('each gesture returns a new config and never mutates', () => {
  const start = defaultHomeConfig();
  const frozen = JSON.stringify(start);
  const moved = moveHomeBlock(start, 'reviews', -1);
  assert.equal(JSON.stringify(start), frozen);
  assert.equal(types(moved).indexOf('reviews'), types(start).indexOf('reviews') - 1);
  assert.equal(moveHomeBlock(start, 'projects', -1), start, 'the first block cannot go up');
  assert.equal(moveHomeBlock(start, 'health', 1), start, 'the last block cannot go down');
  assert.ok(!types(removeHomeBlock(start, 'notebooks')).includes('notebooks'));
  const added = addHomeBlock(start, 'documents');
  assert.equal(types(added).at(-1), 'documents');
  assert.equal(addHomeBlock(added, 'documents'), added, 'a block shows once');
  assert.equal(addHomeBlock(start, 'unknown'), start);
  assert.equal(sizeHomeBlock(start, 'projects').blocks[0].size, 'half');
});

test('every block type has a title for the bar', () => {
  assert.equal(new Set(HOME_BLOCK_TYPES).size, HOME_BLOCK_TYPES.length);
  assert.ok(NOTEBOOK_WEB_ASSETS.has('/assets/ui/home-config.mjs'));
});

test('the Hub keeps the Home in home.json next to the preferences, with a revision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-home-'));
  try {
    const preferences = path.join(dir, 'preferences.json');
    assert.equal(homeConfigPath(preferences), path.join(dir, 'home.json'));
    const first = readHomeConfig(preferences);
    assert.equal(first.stored, false);
    const next = removeHomeBlock(first.home, 'notebooks');
    const written = writeHomeConfig(next, preferences);
    assert.equal(written.stored, true);
    const again = readHomeConfig(preferences);
    assert.deepEqual(again.home, next);
    assert.equal(again.revision, written.revision);
    assert.equal(fs.statSync(path.join(dir, 'home.json')).mode & 0o777, 0o600);
    assert.throws(() => writeHomeConfig(next, preferences, { expectedRevision: first.revision }), /changed on another device/);
    fs.writeFileSync(path.join(dir, 'home.json'), '{broken');
    assert.equal(readHomeConfig(preferences).stored, false, 'a damaged file falls back to the default');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
