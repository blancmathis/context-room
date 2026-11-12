import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentFileMarkers, agentLevelFolders, groupAgentLevels } from '../src/context_levels.mjs';

test('agent levels: the markers follow the provider profile', () => {
  assert.ok(agentFileMarkers('codex').includes('AGENTS.md'));
  assert.ok(agentFileMarkers('codex').includes('.agents/skills'));
  assert.ok(!agentFileMarkers('codex').includes('CLAUDE.md'));
  assert.ok(agentFileMarkers('claude-code').includes('.claude/skills'));
  assert.ok(agentFileMarkers('all').includes('CLAUDE.md') && agentFileMarkers('all').includes('AGENTS.md'));
});

test('agent levels: only subfolders with agent files are levels, skipped folders are not walked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-levels-'));
  try {
    const put = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), '# x\n'); };
    put('AGENTS.md');
    put('app/AGENTS.md');
    put('app/deep/web/AGENTS.md');
    put('docs/readme.md');
    put('node_modules/pkg/AGENTS.md');
    put('lib/.agents/skills/a/SKILL.md');
    put('lib2/CLAUDE.md');
    const skip = (name) => name === 'node_modules' || name.startsWith('.');
    assert.deepEqual(agentLevelFolders(root, 'codex', { skip }), ['app', 'lib', 'app/deep/web']);
    assert.deepEqual(agentLevelFolders(root, 'claude-code', { skip }), ['lib2']);
    assert.deepEqual(agentLevelFolders(root, 'codex', { skip, limit: 1 }), ['app']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent levels: files are grouped global / root / subfolder, once each, with their tokens', () => {
  const root = '/p';
  const entry = (id, scope, subtree, absolutePath, kind = 'instructions') => ({ kind, resource: { id, locator: absolutePath, metadata: { name: path.basename(absolutePath), absolutePath } }, application: { scope, subtree } });
  const effective = (entries, costs) => {
    const value = { instructions: [], skills: [], cost: { entries: costs } };
    for (const item of entries) value[item.kind].push(item);
    return value;
  };
  const global = entry('g', 'device', '.', '/home/me/.codex/AGENTS.md');
  const above = entry('u', 'subtree', '..', '/AGENTS.md');
  const rootFile = entry('r', 'project', '.', '/p/AGENTS.md');
  const skill = entry('s', 'project', '.', '/p/.agents/skills/a/SKILL.md', 'skills');
  const sub = entry('a', 'subtree', 'app', '/p/app/AGENTS.md');
  const costs = { g: { startupTokens: 100 }, u: { startupTokens: 5 }, r: { startupTokens: 50 }, s: { startupTokens: 10, onDemandTokens: 400 }, a: { startupTokens: 30 } };
  const levels = groupAgentLevels([
    { folder: '.', effective: effective([global, above, rootFile, skill], costs) },
    { folder: 'app', effective: effective([global, above, rootFile, skill, sub], costs) },
  ], { root });
  assert.deepEqual(levels.map((level) => [level.level, level.files.map((file) => file.name), level.startupTokens, level.onDemandTokens]), [
    ['global', ['AGENTS.md', 'AGENTS.md'], 105, 0],
    ['root', ['AGENTS.md', 'SKILL.md'], 60, 400],
    ['app', ['AGENTS.md'], 30, 0],
  ]);
  assert.equal(levels[0].files[0].path, '', 'a global file does not open in the project');
  assert.equal(levels[1].files[1].path, '.agents/skills/a/SKILL.md');
  assert.equal(levels[1].files[1].kind, 'skill');
  assert.equal(levels[2].files[0].path, 'app/AGENTS.md');
  assert.deepEqual(groupAgentLevels([{ folder: '.', effective: effective([], {}) }], { root }).map((level) => level.level), ['root'], 'an empty global level is left out, the root stays');
});
