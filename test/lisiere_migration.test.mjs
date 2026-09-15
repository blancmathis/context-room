import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';
import { planLisiereNotebookImport, applyLisiereNotebookImport } from '../src/lisiere_migration.mjs';
import { readNotebook, mutateNotebook, NOTEBOOK_STORE } from '../src/notebooks.mjs';
import { initializeContextRoomProject } from '../src/context_room.mjs';

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
 db.executescript('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root TEXT); CREATE TABLE boards(id TEXT PRIMARY KEY,title TEXT,project TEXT,revision INTEGER); CREATE TABLE objects(board TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(board,id));')
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
