import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';
import { planLisiereNotebookImport, applyLisiereNotebookImport } from '../src/lisiere_migration.mjs';
import { readNotebook, mutateNotebook, openNotebook, listNotebooks, NOTEBOOK_STORE } from '../src/notebooks.mjs';
import { initializeContextRoomProject, ensureContextHubNotebookSpace, migrateNotebooksToSpace } from '../src/context_room.mjs';
import { inspectLisiereSnapshot } from '../src/lisiere_inventory.mjs';

const authority = { canWrite: rel => rel.startsWith('docs/') && rel.endsWith('.crnb') };
async function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-lisiere-import-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'legacy'), snapshot = path.join(base, 'snapshot'), root = path.join(base, 'project');
  fs.mkdirSync(source); fs.mkdirSync(root);
  execFileSync('python3', ['-B', '-c', `import sqlite3,sys,json,base64,hashlib
from pathlib import Path
asset=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=')
asset_id=hashlib.sha256(asset).hexdigest()
assets=Path(sys.argv[1]).parent/'assets'
assets.mkdir()
(assets/asset_id).write_bytes(asset)
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root TEXT); CREATE TABLE boards(id TEXT PRIMARY KEY,title TEXT,project TEXT,revision INTEGER); CREATE TABLE objects(board TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(board,id)); CREATE TABLE drafts(project TEXT,path TEXT,device TEXT,base TEXT,content TEXT,version INTEGER,PRIMARY KEY(project,path,device));')
 db.execute('INSERT INTO drafts VALUES(?,?,?,?,?,?)',('another-project','docs/Earlier.md','original-tablet','original-base','Unsent original text kept in the archive',17))
 db.execute('INSERT INTO projects VALUES(?,?,?)',('another-project','Unrelated private project','/synthetic/private'))
 db.executemany('INSERT INTO boards VALUES(?,?,?,?)',[('board','Original notebook',None,7),('other-board','Unrelated title','another-project',1)])
 db.executemany('INSERT INTO objects VALUES(?,?,?,?)',[('board','shape',7,json.dumps({'type':'rect','x':10,'y':20,'w':100,'h':60})),('board','deleted',5,None),('board','zz-picture',6,json.dumps({'type':'image','assetId':asset_id,'x':200,'y':20,'w':10,'h':10})),('other-board','other',1,json.dumps({'type':'text','text':'Unrelated private content'}))])`, path.join(source, 'workspace.sqlite')], { timeout: 10000, stdio: 'pipe' });
  const exportPlan = await exportLisiereSnapshot({ source, output: snapshot });
  await exportLisiereSnapshot({ source, output: snapshot, apply: true, expectedRevision: exportPlan.revision });
  const options = { snapshot, boardId: 'board', path: 'docs/Ideas.crnb' };
  const plan = () => planLisiereNotebookImport(root, options, authority);
  const apply = revision => applyLisiereNotebookImport(root, { ...options, expectedRevision: revision }, authority);
  return { base, root, source, snapshot, options, plan, apply };
}
function laterEdit(root, scene) {
  mutateNotebook(root, { protocolVersion: 1, resourceId: scene.resourceId, operationId: 'new-owner-edit', locationRevision: scene.locator.revision,
    edits: [{ kind: 'patch', id: 'shape', expectedRevision: 7, patch: { x: 250 } }] }, { ...authority, actor: { kind: 'human', id: 'owner' } });
}

test('actual SQLite export imports only selected original data as editable unaccepted work, with stable receipts', async t => {
  const f = await fixture(t), original = fs.readFileSync(path.join(f.source, 'workspace.sqlite')), plan = f.plan();
  assert.equal(plan.imported, false); assert.equal(plan.source.project, null); assert.equal(plan.deletedObjects, 1);
  assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(f.plan().revision, plan.revision);
  const applied = f.apply(plan.revision);
  assert.equal(applied.applied, true); assert.equal(applied.accepted, false); assert.equal(applied.replayed, false);
  assert.equal(fs.existsSync(path.join(f.root, f.options.path)), false);
  const retained = fs.readFileSync(path.join(f.root, applied.recovery, 'source-board.json'), 'utf8');
  assert.match(retained, /"deleted"/); assert.doesNotMatch(retained, /Unrelated|another-project|other-board/);
  assert.equal(fs.statSync(path.join(f.root, applied.recovery, 'source-board.json')).mode & 0o777, 0o600);
  assert.equal(applied.assets, 1);
  const asset = fs.readdirSync(path.join(f.root, applied.recovery, 'assets'))[0];
  assert.deepEqual(fs.readFileSync(path.join(f.root, applied.recovery, 'assets', asset)), fs.readFileSync(path.join(f.source, 'assets', asset)));
  const scene = readNotebook(f.root, applied.resourceId); assert.equal(scene.document.objects[0].createdBy.kind, 'import');
  assert.equal(scene.tombstones.deleted, 5); laterEdit(f.root, scene);
  const repeated = f.apply(plan.revision); assert.equal(repeated.replayed, true); assert.equal(repeated.currentRevision, 8);
  assert.equal(readNotebook(f.root, applied.resourceId).document.objects[0].x, 250);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'workspace.sqlite')), original);
});

test('each interrupted backup, publication and acknowledgement resumes without duplicating later human work', async t => {
  for (const suffix of ['/source-board.json', '/backed-up.json', '/header.json', '/applied.json']) {
    const f = await fixture(t), plan = f.plan(), originalLink = fs.linkSync; let interrupted = false;
    fs.linkSync = (from, to, ...rest) => { originalLink(from, to, ...rest); if (String(to).endsWith(suffix) && !interrupted) { interrupted = true; throw new Error('Injected interrupted publication'); } };
    try { assert.throws(() => f.apply(plan.revision), /interrupted publication/); } finally { fs.linkSync = originalLink; }
    assert.equal(interrupted, true);
    const header = path.join(f.root, NOTEBOOK_STORE, 'resources/board/header.json');
    if (fs.existsSync(header)) laterEdit(f.root, readNotebook(f.root, 'board'));
    const result = f.apply(plan.revision); assert.equal(result.applied, true);
    assert.deepEqual(fs.readdirSync(path.join(f.root, NOTEBOOK_STORE, 'resources')), ['board']);
    assert.equal(readNotebook(f.root, 'board').document.objects[0].x, suffix === '/header.json' || suffix === '/applied.json' ? 250 : 10);
  }
});

test('source tampering and a mid-import scope revocation stop before notebook publication with a recoverable backup', async t => {
  const f = await fixture(t), plan = f.plan(), table = path.join(f.snapshot, 'tables/objects.jsonl'), bytes = fs.readFileSync(table);
  fs.writeFileSync(table, bytes.toString().replace('shape', 'other'));
  assert.throws(() => f.apply(plan.revision), /snapshot hash/); assert.deepEqual(fs.readdirSync(f.root), []);
  fs.writeFileSync(table, bytes);
  const originalLink = fs.linkSync; let allowed = true;
  fs.linkSync = (from, to, ...rest) => { originalLink(from, to, ...rest); if (String(to).endsWith('/backed-up.json')) allowed = false; };
  try { assert.throws(() => applyLisiereNotebookImport(f.root, { ...f.options, expectedRevision: plan.revision }, { canWrite: () => allowed }), { code: 'notebook_path_scope' }); }
  finally { fs.linkSync = originalLink; }
  assert.equal(fs.existsSync(path.join(f.root, NOTEBOOK_STORE, 'resources/board/header.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, plan.recovery, 'backed-up.json')), true);
  assert.equal(f.apply(plan.revision).applied, true);
});

test('changed preview, occupied path, denied scope and changed retained bytes never replace existing work', async t => {
  const f = await fixture(t), plan = f.plan();
  assert.throws(() => f.apply('a'.repeat(64)), /changed after/); assert.deepEqual(fs.readdirSync(f.root), []);
  assert.throws(() => applyLisiereNotebookImport(f.root, f.options, authority), /exact migration preview/);
  assert.throws(() => planLisiereNotebookImport(f.root, f.options), { code: 'notebook_path_scope' });
  fs.mkdirSync(path.join(f.root, 'docs')); const occupied = path.join(f.root, f.options.path); fs.writeFileSync(occupied, 'Existing owner file');
  assert.throws(() => f.apply(plan.revision), { code: 'notebook_location_conflict' }); assert.equal(fs.readFileSync(occupied, 'utf8'), 'Existing owner file');
  fs.unlinkSync(occupied); const applied = f.apply(plan.revision);
  const retained = path.join(f.root, applied.recovery, 'source-board.json'); fs.writeFileSync(retained, 'Changed recovery data');
  assert.throws(() => f.apply(plan.revision), /retained migration copy/);
  assert.equal(fs.readFileSync(retained, 'utf8'), 'Changed recovery data'); assert.equal(readNotebook(f.root, 'board').revision, 7);
});

test('a configuration change needs a fresh preview and can then resume the same retained migration', async t => {
  const f = await fixture(t), plan = f.plan(); f.apply(plan.revision);
  const config = path.join(f.root, '.context-room/config.json'); fs.writeFileSync(config, '{"title":"Changed title"}');
  assert.throws(() => f.apply(plan.revision), /changed after/);
  const next = f.plan(); assert.notEqual(next.revision, plan.revision); assert.equal(next.requestId, plan.requestId);
  assert.equal(f.apply(next.revision).replayed, true);
  assert.equal(fs.readdirSync(path.join(f.root, plan.recovery, 'authorizations')).length, 2);
});

test('installed CLI imports through live project watch and write permissions without the legacy executable', async t => {
  const f = await fixture(t);
  execFileSync('git', ['init', '--quiet', f.root], { stdio: 'pipe' });
  initializeContextRoomProject(f.root, { title: 'Migration fixture', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
  const env = { ...process.env, HOME: f.base, CONTEXT_ROOM_HUB_HOME: path.join(f.base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(f.base, 'shared') };
  const run = (extra, targetPath = 'docs/Ideas.crnb') => spawnSync(process.execPath, [cli, 'migrate', '--root', f.root, '--import-lisiere', f.snapshot, '--legacy-board', 'board', '--path', targetPath, ...extra], { encoding: 'utf8', cwd: f.base, env, timeout: 30000 });
  const preview = run(['--plan']); assert.equal(preview.status, 0, preview.stdout + preview.stderr); const plan = JSON.parse(preview.stdout).data;
  assert.equal(fs.existsSync(path.join(f.root, NOTEBOOK_STORE)), false);
  const applied = run(['--apply', '--revision', plan.revision]); assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(JSON.parse(applied.stdout).data.imported, true); assert.equal(run(['--apply', '--revision', plan.revision]).status, 0);
  const imported = JSON.parse(applied.stdout).data;
  for (const rel of [imported.receipt, `${NOTEBOOK_STORE}/resources/board/header.json`, '.context-room/lisiere/sessions/old/session.json'])
    assert.equal(spawnSync('git', ['check-ignore', '--quiet', rel], { cwd: f.root }).status, 0, rel);
  const denied = run([], 'outside/Ideas.crnb'); assert.notEqual(denied.status, 0); assert.match(denied.stdout + denied.stderr, /permission|scope/i);
  const mixed = run(['--export-lisiere', f.source, '--output', path.join(f.base, 'second-snapshot')]); assert.notEqual(mixed.status, 0); assert.match(mixed.stdout + mixed.stderr, /Choose a legacy export/);
  assert.equal(fs.existsSync(path.join(f.base, 'second-snapshot')), false);
});

test('notebooks-to-space preview then apply moves only Lisière imports', async t => {
  const f = await fixture(t);
  execFileSync('git', ['init', '--quiet', f.root], { stdio: 'pipe' });
  initializeContextRoomProject(f.root, { title: 'Recovery fixture', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
  const homes = { HOME: f.base, CONTEXT_ROOM_HUB_HOME: path.join(f.base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(f.base, 'shared'), CONTEXT_ROOM_NOTEBOOK_SPACE_HOME: path.join(f.base, 'Carnets space') };
  const env = { ...process.env, ...homes };
  const run = args => { const out = spawnSync(process.execPath, [cli, 'migrate', ...args], { encoding: 'utf8', cwd: f.root, env, timeout: 30000 }); return { ...out, data: out.status === 0 ? JSON.parse(out.stdout).data : null }; };
  // D10: a board without a project needs the space when --root is absent.
  const noSpace = run(['--import-lisiere', f.snapshot, '--legacy-board', 'board', '--path', 'Carnets/Ideas.crnb']);
  assert.notEqual(noSpace.status, 0); assert.match(noSpace.stdout + noSpace.stderr, /Create the Notebooks space first \(Hub › New notebook\) or pass --root/);
  const saved = Object.fromEntries(Object.keys(homes).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, homes);
  const space = ensureContextHubNotebookSpace().projectRoot;
  const toSpace = run(['--import-lisiere', f.snapshot, '--legacy-board', 'board', '--path', 'Carnets/Ideas.crnb']); assert.equal(toSpace.status, 0, toSpace.stdout + toSpace.stderr);
  assert.equal(run(['--import-lisiere', f.snapshot, '--legacy-board', 'board', '--path', 'Carnets/Ideas.crnb', '--apply', '--revision', toSpace.data.revision]).status, 0);
  assert.deepEqual(listNotebooks(space).map(entry => entry.path), ['Carnets/Ideas.crnb']); assert.deepEqual(listNotebooks(f.root), []);
  // D9: one Lisière import and one ordinary working notebook in the recovery project.
  const other = ['--root', f.root, '--import-lisiere', f.snapshot, '--legacy-board', 'other-board', '--path', 'docs/Other.crnb'];
  assert.equal(run([...other, '--apply', '--revision', run(other).data.revision]).status, 0);
  const plain = openNotebook(f.root, { path: 'docs/Plain.crnb', title: 'Plain', canWrite: rel => rel.startsWith('docs/') });
  const preview = run(['--root', f.root, '--notebooks-to-space']); assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.deepEqual(preview.data.notebooks.map(item => [item.resourceId, item.from, item.to, item.boardId]), [['other-board', 'docs/Other.crnb', 'Carnets/Other.crnb', 'other-board']]);
  assert.equal(preview.data.applied, false); assert.equal(listNotebooks(f.root).length, 2);
  assert.deepEqual(run(['--root', f.root, '--notebooks-to-space', '--legacy-board', 'board']).data.notebooks, []);
  const stale = run(['--root', f.root, '--notebooks-to-space', '--apply', '--revision', 'f'.repeat(64)]); assert.notEqual(stale.status, 0); assert.match(stale.stdout + stale.stderr, /Preview again/);
  const applied = run(['--root', f.root, '--notebooks-to-space', '--apply', '--revision', preview.data.revision]); assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.deepEqual(applied.data.moved.map(item => [item.resourceId, item.to]), [['other-board', 'Carnets/Other.crnb']]);
  assert.deepEqual(listNotebooks(f.root).map(entry => entry.id), [plain.resourceId]);
  assert.deepEqual(listNotebooks(space).map(entry => entry.path).sort(), ['Carnets/Ideas.crnb', 'Carnets/Other.crnb']);
  assert.equal(readNotebook(space, 'other-board').document.title, 'Unrelated title');
  assert.ok(fs.existsSync(path.join(f.root, '.context-room/migrations/lisiere-v1')), 'the retained recovery stays in place');
  assert.deepEqual(run(['--root', f.root, '--notebooks-to-space']).data.notebooks, []);
});

test('inventory paginates exact retained source records without loading a project or exposing draft text', async t => {
  const f = await fixture(t), items = []; let cursor;
  do {
    const page = inspectLisiereSnapshot(f.snapshot, { limit: 1, ...(cursor ? { cursor } : {}) });
    items.push(...page.items); cursor = page.pagination.nextCursor;
    assert.deepEqual(page.counts, { projects: 1, boards: 2, drafts: 1, conversations: 0, operations: 0, recordings: 0 });
  } while (cursor);
  assert.equal(items.length, 4); assert.equal(new Set(items.map(item => item.selector)).size, 4);
  assert.equal(items.find(item => item.kind === 'boards' && item.id === 'board').project, null);
  const draft = items.find(item => item.kind === 'drafts'); assert.equal(draft.version, 17); assert.equal(draft.delivery, 'unconfirmed');
  assert.doesNotMatch(JSON.stringify(items), /Unsent original text/); assert.deepEqual(fs.readdirSync(f.root), []);
  const first = inspectLisiereSnapshot(f.snapshot, { limit: 1 });
  assert.throws(() => inspectLisiereSnapshot(f.snapshot, { kind: 'drafts', cursor: first.pagination.nextCursor }), /another snapshot or selection/);
  assert.throws(() => inspectLisiereSnapshot(f.snapshot, { cursor: '../bad' }), /cursor/);
  for (const limit of [0, 201, Infinity, 'not a number']) assert.throws(() => inspectLisiereSnapshot(f.snapshot, { limit }), /page size/);
  execFileSync('python3', ['-B', '-c', "import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute(\"UPDATE drafts SET content='Different retained text'\")", path.join(f.source, 'workspace.sqlite')], { stdio: 'pipe' });
  const output = path.join(f.base, 'later-snapshot'), plan = await exportLisiereSnapshot({ source: f.source, output });
  await exportLisiereSnapshot({ source: f.source, output, apply: true, expectedRevision: plan.revision });
  assert.throws(() => inspectLisiereSnapshot(output, { cursor: first.pagination.nextCursor }), /another snapshot or selection/);
  assert.notEqual(inspectLisiereSnapshot(output, { kind: 'drafts' }).items[0].selector, draft.selector);
  const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
  const args = [cli, 'migrate', '--inspect-lisiere', f.snapshot, '--kind', 'drafts'];
  const options = { cwd: f.base, encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: f.base,
    CONTEXT_ROOM_HUB_HOME: path.join(f.base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(f.base, 'shared') } };
  const response = JSON.parse(execFileSync(process.execPath, args, options)); assert.equal(response.ok, true); assert.equal(response.target, null);
  assert.equal(response.data.items[0].selector, draft.selector);
  const denied = spawnSync(process.execPath, [...args, '--apply'], options); assert.notEqual(denied.status, 0); assert.match(denied.stdout + denied.stderr, /read-only/);
});

test('notebooks-to-space preview writes nothing, lists refused notebooks and resumes after a crash before and after its commit', async t => {
  const f = await fixture(t);
  execFileSync('git', ['init', '--quiet', f.root], { stdio: 'pipe' });
  initializeContextRoomProject(f.root, { title: 'Recovery fixture', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  f.apply(f.plan().revision);
  const other = { snapshot: f.snapshot, boardId: 'other-board', path: 'docs/Other.crnb' };
  applyLisiereNotebookImport(f.root, { ...other, expectedRevision: planLisiereNotebookImport(f.root, other, authority).revision }, authority);
  const homes = { CONTEXT_ROOM_HUB_HOME: path.join(f.base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(f.base, 'shared'), CONTEXT_ROOM_NOTEBOOK_SPACE_HOME: path.join(f.base, 'Carnets space') };
  const saved = Object.fromEntries(Object.keys(homes).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, homes);
  const space = ensureContextHubNotebookSpace().projectRoot;
  openNotebook(space, { path: 'Carnets/Ideas.crnb', id: 'space-taken', canWrite: rel => rel.startsWith('Carnets/') });
  const tree = () => [f.root, space].flatMap(root => fs.readdirSync(root, { recursive: true }).filter(rel => !String(rel).startsWith('.git/')).sort()
    .map(rel => { const stats = fs.lstatSync(path.join(root, rel)); return [root, rel, stats.size, stats.mtimeMs]; }));
  const before = tree(), preview = migrateNotebooksToSpace(f.root);
  assert.deepEqual(tree(), before, 'the preview writes nothing');
  assert.deepEqual(preview.notebooks.map(item => [item.resourceId, item.to, item.resume]), [['other-board', 'Carnets/Other.crnb', false]]);
  assert.deepEqual(preview.refused.map(item => [item.resourceId, item.to, item.code]), [['board', 'Carnets/Ideas.crnb', 'notebook_location_conflict']]);
  assert.match(preview.refused[0].reason, /Nothing was overwritten/);
  const crash = (match, operation) => {
    const link = fs.linkSync, rename = fs.renameSync;
    const guard = original => (from, to) => { if (match(String(to))) throw Object.assign(new Error('simulated crash'), { code: 'EIO' }); return original(from, to); };
    fs.linkSync = guard(link); fs.renameSync = guard(rename);
    try { assert.throws(operation, /simulated crash/); } finally { fs.linkSync = link; fs.renameSync = rename; }
  };
  const apply = revision => migrateNotebooksToSpace(f.root, { apply: true, expectedRevision: revision });
  const where = () => [listNotebooks(f.root).map(entry => entry.id).sort(), listNotebooks(space).map(entry => entry.id).sort()];
  // Before the commit point the source stays active, and the same preview still applies.
  crash(to => to.includes('/moved/'), () => apply(preview.revision));
  assert.deepEqual(where(), [['board', 'other-board'], ['space-taken']]);
  assert.equal(migrateNotebooksToSpace(f.root).revision, preview.revision);
  // After the commit point the space holds the notebook; a new preview lists the finish to do.
  crash(to => to.includes('/retired/'), () => apply(preview.revision));
  assert.deepEqual(where(), [['board'], ['other-board', 'space-taken']]);
  const resume = migrateNotebooksToSpace(f.root);
  assert.deepEqual(resume.notebooks.map(item => [item.resourceId, item.resume, item.boardId]), [['other-board', true, 'other-board']]);
  assert.deepEqual(resume.refused.map(item => item.resourceId), ['board']);
  assert.deepEqual(apply(resume.revision).moved.map(item => [item.resourceId, item.replayed]), [['other-board', true]]);
  assert.deepEqual(where(), [['board'], ['other-board', 'space-taken']]);
  assert.equal(readNotebook(space, 'other-board').document.title, 'Unrelated title');
  assert.ok(fs.readdirSync(path.join(f.root, NOTEBOOK_STORE, 'retired')).some(name => name.startsWith('other-board-space-')));
  const after = migrateNotebooksToSpace(f.root);
  assert.deepEqual([after.notebooks, after.refused.map(item => item.resourceId)], [[], ['board']]);
});
