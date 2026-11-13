import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentFileMarkers, agentLevelFolders, groupAgentLevels, subfolderAgentRows } from '../src/context_levels.mjs';

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

test('agent levels: a root reached through a link still opens its files', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-levels-real-'));
  const link = real + '-link';
  try {
    fs.symlinkSync(real, link);
    const absolutePath = path.join(fs.realpathSync(real), 'AGENTS.md');
    const effective = { instructions: [{ resource: { id: 'r', locator: absolutePath, metadata: { name: 'AGENTS.md', absolutePath } }, application: { scope: 'project', subtree: '.' } }], skills: [], cost: { entries: {} } };
    const [level] = groupAgentLevels([{ folder: '.', effective }], { root: link });
    assert.equal(level.level, 'root');
    assert.equal(level.files[0].path, 'AGENTS.md');
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('agent levels: one walk finds subfolder files, skills and PLAN/CONTEXT with tokens, and the root context wins on duplicates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-levels-walk-'));
  try {
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    put('AGENTS.md', '# root\n');
    put('PLAN.md', 'plan plan plan plan\n');
    put('app/AGENTS.md', '# app rules\n');
    put('app/.agents/skills/build/SKILL.md', '---\nname: build\ndescription: Build it\n---\nRun the build now.\n');
    put('node_modules/x/AGENTS.md', '# no\n');
    const skip = (name) => name === 'node_modules' || name.startsWith('.');
    const rows = subfolderAgentRows(root, 'codex', { skip });
    assert.deepEqual(rows.map((row) => [row.level, row.kind, row.name]), [['app', 'instruction', 'AGENTS.md'], ['app', 'skill', 'build'], ['root', 'document', 'PLAN.md']]);
    assert.ok(rows[0].startupTokens > 0 && rows[1].startupTokens > 0 && rows[1].onDemandTokens > 0 && rows[2].onDemandTokens > 0 && rows[2].startupTokens === null);
    const real = fs.realpathSync(root);
    const rootEntry = { resource: { id: 'r', locator: real + '/AGENTS.md', metadata: { name: 'AGENTS.md', absolutePath: real + '/AGENTS.md' } }, application: { scope: 'project', subtree: '.' } };
    const effective = { instructions: [rootEntry], skills: [], cost: { entries: { r: { startupTokens: 9 } } } };
    const levels = groupAgentLevels([{ folder: '.', effective }], { root, extra: [...rows, { ...rows[0], level: 'root', name: 'AGENTS.md', absolutePath: path.join(root, 'AGENTS.md') }] });
    assert.deepEqual(levels.map((level) => [level.level, level.files.map((file) => file.path)]), [
      ['root', ['AGENTS.md', 'PLAN.md']],
      ['app', ['app/AGENTS.md', 'app/.agents/skills/build/SKILL.md']],
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent levels: subfolder rows follow one-file-per-folder, Claude rules, managed-only and the start-up settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-levels-rules-'));
  try {
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    put('a/AGENTS.override.md', '# override\n');
    put('a/AGENTS.md', '# plain\n');
    put('b/AGENTS.md', '# b agents\n');
    put('b/CLAUDE.md', '# b claude\n');
    put('c/.claude/rules/deep/style.md', '# style\n');
    const names = (rows, level) => rows.filter((row) => row.level === level).map((row) => row.name);
    const skip = (name) => name.startsWith('.');
    // Codex loads only the override of a folder.
    assert.deepEqual(names(subfolderAgentRows(root, 'codex', { skip }), 'a'), ['AGENTS.override.md']);
    // OpenCode takes the first file of a folder.
    assert.deepEqual(names(subfolderAgentRows(root, 'opencode', { skip }), 'b'), ['AGENTS.md']);
    // Claude reads CLAUDE.md and the rules of a subfolder, however deep.
    assert.deepEqual(names(subfolderAgentRows(root, 'claude-code', { skip }), 'b'), ['CLAUDE.md']);
    assert.deepEqual(names(subfolderAgentRows(root, 'claude-code', { skip }), 'c'), ['style.md']);
    // provider=all: the union per provider, each file once.
    const all = subfolderAgentRows(root, 'all', { skip });
    assert.deepEqual(names(all, 'a').sort(), ['AGENTS.md', 'AGENTS.override.md']); // Codex: override; OpenCode: AGENTS.md
    assert.deepEqual(names(all, 'b').sort(), ['AGENTS.md', 'CLAUDE.md']);
    // Managed-only drops Claude's project files; the start-up setting drops instructions.
    assert.deepEqual(subfolderAgentRows(root, 'claude-code', { skip, managedOnly: true }), []);
    assert.deepEqual(subfolderAgentRows(root, 'codex', { skip, instructions: false }), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent levels: PLAN/CONTEXT tokens are counted apart from skill bodies', () => {
  const rows = [{ level: 'root', kind: 'document', name: 'PLAN.md', absolutePath: '/nowhere/PLAN.md', startupTokens: null, onDemandTokens: 50 }];
  const [level] = groupAgentLevels([{ folder: '.', effective: { instructions: [], skills: [], cost: { entries: {} } } }], { root: '/nowhere', extra: rows });
  assert.equal(level.documentTokens, 50);
  assert.equal(level.onDemandTokens, 0);
});
