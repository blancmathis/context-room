import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillAndMcpLevels, toolLevelMarkers } from '../src/context_tools.mjs';
import { filterLevels, countItems } from '../src/ui/skills-mcp.mjs';
import { NOTEBOOK_WEB_ASSETS } from '../src/notebook_web_assets.mjs';

const skill = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

// A device home and a project, each with skills and MCP files of several providers. Every MCP value holds « s3cr3t ».
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-tools-')));
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  const before = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(path.join(home, '.claude/skills/review/SKILL.md'), skill('review', 'Review a diff.', 'Global body.'));
  put(path.join(home, '.agents/skills/deploy/SKILL.md'), skill('deploy', 'Deploy the app.', 'Same body.'));
  put(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { github: { command: 'npx', env: { TOKEN: 's3cr3t-global' } } },
    projects: { [root]: { mcpServers: { private: { command: 's3cr3t-command', env: { K: 's3cr3t-local' } } } } },
  }));
  put(path.join(home, '.codex/config.toml'), '[mcp_servers.github]\ncommand = "gh"\n\n[mcp_servers.github.env]\nTOKEN = "s3cr3t-toml"\n');
  put(path.join(root, '.claude/skills/review/SKILL.md'), skill('review', 'Review a diff, project rules.', 'Project body.'));
  put(path.join(root, '.agents/skills/deploy/SKILL.md'), skill('deploy', 'Deploy the app.', 'Same body.'));
  put(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
    github: { command: 'npx', args: ['--token', 's3cr3t-arg'], env: { TOKEN: 's3cr3t-project' } },
    db: { url: 'https://s3cr3t-url.example', headers: { Authorization: 'Bearer s3cr3t-header' } },
  } }));
  put(path.join(root, 'app/.claude/skills/build/SKILL.md'), skill('build', 'Build the app. ' + 'Long. '.repeat(60), 'Build body.'));
  put(path.join(root, 'app/.mcp.json'), JSON.stringify({ mcpServers: { figma: { command: 'figma', env: { KEY: 's3cr3t-folder' } } } }));
  put(path.join(root, 'node_modules/pkg/.claude/skills/hidden/SKILL.md'), skill('hidden', 'Not a level.', 'No.'));
  return { home, root, read: () => skillAndMcpLevels(root, { skip: (name) => name === 'node_modules' }) };
}

const level = (levels, name) => levels.find((item) => item.level === name);
const item = (levels, name, itemName, source) => level(levels, name).items.find((entry) => entry.name === itemName && (!source || entry.source === source));

test('skills and MCP levels: the markers come from every provider profile', () => {
  const markers = toolLevelMarkers();
  for (const marker of ['.agents/skills', '.claude/skills', '.opencode/skills', '.mcp.json', '.codex/config.toml', 'opencode.json']) assert.ok(markers.includes(marker), marker);
  assert.ok(markers.every((marker) => !marker.startsWith('~') && !path.isAbsolute(marker)));
});

test('skills are listed once per file under global / root / subfolder, with the providers that read them and their tokens', (t) => {
  const { skills, providers, truncated } = fixture(t).read();
  assert.deepEqual(providers.map((provider) => provider.id), ['codex', 'claude-code', 'opencode']);
  assert.equal(truncated, false);
  assert.deepEqual(skills.map((entry) => entry.level), ['global', 'root', 'app']);
  assert.deepEqual(level(skills, 'global').items.map((entry) => [entry.name, entry.source, entry.path, entry.providers]), [
    ['deploy', '~/.agents/skills/deploy/SKILL.md', '', ['codex', 'opencode']],
    ['review', '~/.claude/skills/review/SKILL.md', '', ['claude-code', 'opencode']],
  ]);
  assert.deepEqual(level(skills, 'root').items.map((entry) => [entry.name, entry.path]), [['deploy', '.agents/skills/deploy/SKILL.md'], ['review', '.claude/skills/review/SKILL.md']]);
  const build = item(skills, 'app', 'build');
  assert.equal(build.path, 'app/.claude/skills/build/SKILL.md');
  assert.ok(build.startupTokens > build.onDemandTokens && build.onDemandTokens > 0, 'start = name and description, on demand = body');
  assert.ok(build.description.length <= 200 && build.description.endsWith('…'));
  assert.ok(!JSON.stringify(skills).includes('hidden'), 'a skipped folder is not walked');
  assert.ok(skills.every((entry) => entry.items.every((row) => !('hash' in row) && !('level' in row))));
});

test('a name seen twice by one provider is flagged on both sides, with equal or different content; no winner is named', (t) => {
  const { skills } = fixture(t).read();
  assert.deepEqual(item(skills, 'root', 'deploy').duplicates, [{ level: 'global', source: '~/.agents/skills/deploy/SKILL.md', providers: ['codex', 'opencode'], same: true }]);
  assert.deepEqual(item(skills, 'global', 'review').duplicates, [{ level: 'root', source: '.claude/skills/review/SKILL.md', providers: ['claude-code', 'opencode'], same: false }]);
  assert.deepEqual(item(skills, 'app', 'build').duplicates, []);
});

test('MCP servers: names, source files, levels and state only; never a command, an argument, a URL, an env value or a header', (t) => {
  const { home, root, read } = fixture(t);
  const result = read();
  const { mcp } = result;
  assert.deepEqual(mcp.map((entry) => entry.level), ['global', 'root', 'app']);
  assert.deepEqual(level(mcp, 'global').items.map((entry) => [entry.name, entry.source, entry.providers, entry.status]), [
    ['github', '~/.claude.json', ['claude-code'], 'configured'],
    ['github', '~/.codex/config.toml', ['codex'], 'configured'],
  ]);
  // Two providers, one name, two files: no provider sees both, so no warning between them.
  assert.deepEqual(item(mcp, 'global', 'github', '~/.codex/config.toml').duplicates, []);
  assert.deepEqual(item(mcp, 'global', 'github', '~/.claude.json').duplicates, [{ level: 'root', source: '.mcp.json', providers: ['claude-code'], same: false }]);
  assert.deepEqual(level(mcp, 'root').items.map((entry) => [entry.name, entry.source, entry.local, entry.status]), [
    ['db', '.mcp.json', false, 'approval'],
    ['github', '.mcp.json', false, 'approval'],
    ['private', '~/.claude.json', true, 'configured'],
  ]);
  assert.deepEqual(level(mcp, 'app').items.map((entry) => [entry.name, entry.source]), [['figma', 'app/.mcp.json']]);
  const sent = JSON.stringify(result);
  for (const secret of ['s3cr3t', 'npx', 'Bearer', 'https://', '--token']) assert.ok(!sent.includes(secret), secret + ' must not leave the server');
  assert.ok(!sent.includes(home) && !sent.includes(root), 'paths are relative to the project or to ~');
  const allowed = new Set(['name', 'source', 'local', 'status', 'providers', 'duplicates']);
  for (const entry of mcp) for (const row of entry.items) assert.deepEqual(Object.keys(row).filter((key) => !allowed.has(key)), []);
});

test('a project without skills or MCP still answers the global and root levels; a failing reader gives an empty list', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-tools-empty-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const broken = { listProviderSkillFolders() { throw new Error('unreadable'); }, listProviderMcpServers() { throw new Error('unreadable'); } };
  const result = skillAndMcpLevels(base, { readers: broken, home: path.join(base, 'home') });
  assert.deepEqual(result.skills, [{ level: 'global', items: [] }, { level: 'root', items: [] }]);
  assert.deepEqual(result.mcp, [{ level: 'global', items: [] }, { level: 'root', items: [] }]);
});

test('the panel filters by provider: its items, its own duplicates, its token totals; global and root stay when empty', (t) => {
  const { skills, mcp } = fixture(t).read();
  const all = filterLevels(skills);
  assert.equal(countItems(all), 5);
  assert.equal(all[0].startupTokens, skills[0].items.reduce((sum, entry) => sum + entry.startupTokens, 0));
  const codex = filterLevels(skills, 'codex');
  assert.deepEqual(codex.map((entry) => [entry.level, entry.items.map((row) => row.name)]), [['global', ['deploy']], ['root', ['deploy']]]);
  assert.equal(codex[0].onDemandTokens, codex[0].items[0].onDemandTokens);
  assert.deepEqual(codex[0].items[0].duplicates.map((other) => other.level), ['root']);
  const claude = filterLevels(skills, 'claude-code');
  assert.deepEqual(claude.map((entry) => entry.level), ['global', 'root', 'app']);
  assert.ok(claude.every((entry) => entry.items.every((row) => row.name !== 'deploy')));
  assert.deepEqual(filterLevels(mcp, 'opencode'), [{ level: 'global', items: [], startupTokens: 0, onDemandTokens: 0 }, { level: 'root', items: [], startupTokens: 0, onDemandTokens: 0 }]);
  assert.deepEqual(filterLevels(mcp, 'codex')[0].items.map((row) => row.source), ['~/.codex/config.toml']);
  assert.equal(skills[0].items.length, 2, 'the source is not changed');
});

test('the panel is its own asset, loaded by the project page on the first press', () => {
  assert.equal(NOTEBOOK_WEB_ASSETS.get('/assets/ui/skills-mcp.mjs')?.file, 'ui/skills-mcp.mjs');
  const page = fs.readFileSync(new URL('../src/ui/project-page.mjs', import.meta.url), 'utf8');
  assert.match(page, /import\('\/assets\/ui\/skills-mcp\.mjs'\)/);
  assert.match(page, /data-pp-tools/);
});
