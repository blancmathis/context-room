import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readCodexDesktopCatalog, previewCodexProjectImport, applyCodexProjectImport, codexSessionRoots, clearCodexSessionRootsCache } from '../src/codex_catalog.mjs';
import { listContextHubProjects, registerContextHubProject } from '../src/context_hub.mjs';

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-codex-catalog-')));
  const previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { previous[key] = process.env[key]; process.env[key] = path.join(base, key); }
  const codexHome = path.join(base, 'codex'); fs.mkdirSync(codexHome);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(base, { recursive: true, force: true }); });
  const folder = name => { const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const write = (projects, order) => fs.writeFileSync(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({ 'local-projects': projects, 'project-order': order ?? Object.keys(projects) }));
  const entry = (id, name, rootPaths) => ({ id, name, rootPaths });
  return { base, codexHome, folder, write, entry };
}
const fakeInit = (root, { title }) => { fs.mkdirSync(path.join(root, '.context-room'), { recursive: true }); fs.writeFileSync(path.join(root, '.context-room/config.json'), JSON.stringify({ title })); };

test('the catalog reads local-projects in project-order, then the rest, and splits multi-root projects', t => {
  const s = sandbox(t), a = s.folder('a'), b = s.folder('b'), c = s.folder('c');
  s.write({ x: s.entry('x', 'Alpha', [a]), y: s.entry('y', 'Beta', [b, c]), z: s.entry('z', 'Zeta', [s.folder('z')]) }, ['y', 'missing-id', 'x']);
  const catalog = readCodexDesktopCatalog({ codexHome: s.codexHome });
  assert.equal(catalog.found, true);
  assert.deepEqual(catalog.projects.map(project => project.root), [b, c, a, path.join(s.base, 'z')]);
  assert.deepEqual(catalog.projects.map(project => project.key), ['y', 'y:1', 'x', 'z']);
  assert.equal(catalog.projects[1].name, 'Beta · c');
});

test('a missing catalog is empty, and an oversized or damaged one is refused', t => {
  const s = sandbox(t);
  assert.deepEqual(readCodexDesktopCatalog({ codexHome: s.codexHome }).projects, []);
  const file = path.join(s.codexHome, '.codex-global-state.json');
  fs.writeFileSync(file, '{ broken'); assert.throws(() => readCodexDesktopCatalog({ codexHome: s.codexHome }), { code: 'codex_catalog_unreadable' });
  fs.writeFileSync(file, 'x'.repeat(21 * 1024 * 1024)); assert.throws(() => readCodexDesktopCatalog({ codexHome: s.codexHome }), { code: 'codex_catalog_unreadable' });
});

test('the preview refuses the home folder, Codex and SSH folders, relative roots and symbolic links', t => {
  const s = sandbox(t), real = s.folder('real'), link = path.join(s.base, 'link'); fs.symlinkSync(real, link);
  s.write({ h: s.entry('h', 'Home', [os.homedir()]), c: s.entry('c', 'Codex', [s.codexHome]), r: s.entry('r', 'Relative', ['relative/dir']), l: s.entry('l', 'Link', [link]), s: s.entry('s', 'Ssh', [path.join(os.homedir(), '.ssh')]) });
  const preview = previewCodexProjectImport({ codexHome: s.codexHome });
  assert.deepEqual(preview.projects.map(row => row.status), ['refused', 'refused', 'refused', 'refused', 'refused']);
  assert.equal(preview.counts.refused, 5);
});

test('the preview marks registered, ready, needs-init and missing folders and writes nothing', t => {
  const s = sandbox(t), reg = s.folder('reg'), ready = s.folder('ready'), fresh = s.folder('fresh');
  fakeInit(reg, { title: 'Reg' }); fakeInit(ready, { title: 'Ready' });
  registerContextHubProject(reg, { title: 'Reg' });
  s.write({ a: s.entry('a', 'Reg', [reg]), b: s.entry('b', 'Ready', [ready]), c: s.entry('c', 'Fresh', [fresh]), d: s.entry('d', 'Gone', [path.join(s.base, 'gone')]) });
  const before = listContextHubProjects({ readOnly: true }).length;
  const preview = previewCodexProjectImport({ codexHome: s.codexHome });
  assert.deepEqual(preview.projects.map(row => row.status), ['registered', 'ready', 'needs-init', 'missing']);
  assert.deepEqual(preview.counts, { registered: 1, ready: 1, 'needs-init': 1, missing: 1, refused: 0 });
  assert.equal(listContextHubProjects({ readOnly: true }).length, before);
  assert.equal(fs.existsSync(path.join(fresh, '.context-room')), false);
});

test('apply initializes only the chosen folders and never registers a registered folder again', async t => {
  const s = sandbox(t), reg = s.folder('reg'), fresh = s.folder('fresh'), other = s.folder('other');
  fakeInit(reg, { title: 'Reg' }); const first = registerContextHubProject(reg, { title: 'Reg' });
  s.write({ a: s.entry('a', 'Reg', [reg]), b: s.entry('b', 'Fresh', [fresh]), c: s.entry('c', 'Other', [other]) });
  const { revision } = previewCodexProjectImport({ codexHome: s.codexHome });
  const result = await applyCodexProjectImport({ roots: [reg, fresh], expectedRevision: revision, codexHome: s.codexHome, initialize: fakeInit, record: false });
  assert.deepEqual(result.results.map(item => item.outcome), ['skipped', 'imported']);
  assert.equal(result.results[1].initialized, true);
  assert.equal(fs.existsSync(path.join(fresh, '.context-room/config.json')), true);
  assert.equal(fs.existsSync(path.join(other, '.context-room')), false);
  const after = listContextHubProjects({ readOnly: true });
  assert.equal(after.filter(entry => entry.root === reg).length, 1); assert.equal(after.find(entry => entry.root === reg).id, first.id);
  assert.equal(after.some(entry => entry.root === other), false);
});

test('apply refuses a stale revision, an unknown folder and missing arguments', async t => {
  const s = sandbox(t), a = s.folder('a'), b = s.folder('b');
  s.write({ a: s.entry('a', 'A', [a]) });
  const { revision } = previewCodexProjectImport({ codexHome: s.codexHome });
  s.write({ a: s.entry('a', 'A', [a]), b: s.entry('b', 'B', [b]) });
  await assert.rejects(applyCodexProjectImport({ roots: [a], expectedRevision: revision, codexHome: s.codexHome, initialize: fakeInit }), { code: 'codex_import_stale', statusCode: 409 });
  const fresh = previewCodexProjectImport({ codexHome: s.codexHome }).revision;
  const unknown = await applyCodexProjectImport({ roots: [s.folder('elsewhere')], expectedRevision: fresh, codexHome: s.codexHome, initialize: fakeInit, record: false });
  assert.equal(unknown.results[0].outcome, 'failed');
  await assert.rejects(applyCodexProjectImport({ roots: [], expectedRevision: fresh, codexHome: s.codexHome }), { code: 'codex_import_roots' });
  await assert.rejects(applyCodexProjectImport({ roots: [a], codexHome: s.codexHome }), { code: 'codex_import_revision' });
});

test('session roots add live worktrees of the same repository and never a parent repository', async t => {
  const s = sandbox(t), repo = s.folder('repo'), env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'f'), 'x'); git('add', '.'); git('commit', '-qm', 'one');
  const tree = path.join(s.base, 'tree'); git('worktree', 'add', '-q', tree, '-b', 'side');
  fs.mkdirSync(path.join(repo, 'sub'));
  assert.deepEqual(await codexSessionRoots(repo), [repo, fs.realpathSync(tree)]);
  assert.deepEqual(await codexSessionRoots(path.join(repo, 'sub')), [path.join(repo, 'sub')]);
  assert.deepEqual(await codexSessionRoots(s.folder('plain')), [path.join(s.base, 'plain')]);
});

test('a moved registered folder is registered by durable identity, keeps its Shared link, and is never registered again', async t => {
  const s = sandbox(t), old = s.folder('old'), plain = s.folder('plain');
  fakeInit(old, { title: 'Old' });
  const shared = { repository: path.join(s.base, 'remote.git'), projectId: 'demo' };
  const first = registerContextHubProject(old, { title: 'Old', shared });
  const moved = path.join(s.base, 'moved'); fs.renameSync(old, moved);
  s.write({ a: s.entry('a', 'Moved', [moved]), b: s.entry('b', 'Plain', [plain]) });
  const before = JSON.stringify(listContextHubProjects({ readOnly: true }).map(({ id, root, shared }) => [id, root, shared]));
  const preview = previewCodexProjectImport({ codexHome: s.codexHome });
  const row = preview.projects[0];
  assert.equal(row.status, 'registered'); assert.equal(row.moved, true); assert.equal(row.projectId, first.id);
  assert.equal(row.registeredRoot, old); assert.equal(row.available, false); assert.equal(row.needsConfirmation, true);
  assert.equal(preview.counts.ready, 0);
  const result = await applyCodexProjectImport({ roots: [moved], expectedRevision: preview.revision, codexHome: s.codexHome, initialize: fakeInit, record: false });
  assert.deepEqual(result.results.map(item => item.outcome), ['skipped']);
  assert.equal(JSON.stringify(listContextHubProjects({ readOnly: true }).map(({ id, root, shared }) => [id, root, shared])), before);
});

test('an « identity to confirm » entry stays registered and points to the confirmation gesture', async t => {
  const s = sandbox(t), root = s.folder('unconfirmed');
  fakeInit(root, { title: 'U' });
  const entry = registerContextHubProject(root, { title: 'U', shared: { repository: path.join(s.base, 'remote.git'), projectId: 'demo' } });
  const file = path.join(process.env.CONTEXT_ROOM_HUB_HOME, 'registry.json'), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stored = raw.projects.find(item => item.id === entry.id); stored.rootDurableIdentity = null; stored.rootIdentity.dev = String(BigInt(stored.rootIdentity.dev) + 1n);
  fs.writeFileSync(file, JSON.stringify(raw));
  s.write({ a: s.entry('a', 'U', [root]) });
  const preview = previewCodexProjectImport({ codexHome: s.codexHome });
  assert.equal(preview.projects[0].status, 'registered'); assert.equal(preview.projects[0].needsConfirmation, true); assert.equal(preview.projects[0].projectId, entry.id);
  const result = await applyCodexProjectImport({ roots: [root], expectedRevision: preview.revision, codexHome: s.codexHome, initialize: fakeInit, record: false });
  assert.deepEqual(result.results.map(item => item.outcome), ['skipped']);
  assert.equal(listContextHubProjects({ readOnly: true }).length, 1);
  assert.deepEqual(listContextHubProjects({ readOnly: true })[0].shared, entry.shared);
});

test('two paths to the same folder give one row, and session roots are cached for a moment', async t => {
  const s = sandbox(t), a = s.folder('a'), link = path.join(s.base, 'alias'); fs.symlinkSync(a, link);
  s.write({ x: s.entry('x', 'A', [a]), y: s.entry('y', 'Alias', [link]) });
  assert.equal(readCodexDesktopCatalog({ codexHome: s.codexHome }).projects.length, 1);
  clearCodexSessionRootsCache();
  const [first, second] = await Promise.all([codexSessionRoots(a), codexSessionRoots(a)]);
  assert.deepEqual(first, second); first.push('mutated');
  assert.deepEqual(await codexSessionRoots(a), [a]);
});

test('the preview refuses folders inside Codex and SSH private state, not only the folders themselves', t => {
  const s = sandbox(t), inside = path.join(s.codexHome, 'worktrees', 'task'); fs.mkdirSync(inside, { recursive: true });
  const sibling = path.join(s.base, 'codex-sibling'); fs.mkdirSync(sibling);
  s.write({ i: s.entry('i', 'Inside', [inside]), o: s.entry('o', 'Sibling', [sibling]), d: s.entry('d', 'Deep', [path.join(os.homedir(), '.ssh', 'nested', 'folder')]) });
  const rows = previewCodexProjectImport({ codexHome: s.codexHome }).projects;
  assert.equal(rows[0].status, 'refused'); assert.equal(rows[2].status, 'refused');
  assert.notEqual(rows[1].status, 'refused', 'a sibling whose name starts with the same text stays allowed');
});

test('when the folder is initialized but the registration fails, the reason says so', async t => {
  const s = sandbox(t), root = s.folder('half');
  s.write({ a: s.entry('a', 'Half', [root]) });
  const { revision } = previewCodexProjectImport({ codexHome: s.codexHome });
  const broken = dir => { fs.mkdirSync(path.join(s.base, 'elsewhere')); fs.symlinkSync(path.join(s.base, 'elsewhere'), path.join(dir, '.context-room')); };
  const result = await applyCodexProjectImport({ roots: [root], expectedRevision: revision, codexHome: s.codexHome, initialize: broken, record: false });
  assert.equal(result.results[0].outcome, 'failed');
  assert.match(result.results[0].reason, /initialized/);
  assert.equal(fs.existsSync(path.join(root, '.context-room')), true);
});
