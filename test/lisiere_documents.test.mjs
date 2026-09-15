import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';
import { inspectLisiereSnapshot } from '../src/lisiere_inventory.mjs';
import { migrateLisiereDocument } from '../src/lisiere_documents.mjs';
import { listLocalProposals, submitLocalProposal, readLocalProposalFile } from '../src/local_proposals.mjs';
import { initializeContextRoomProject, createMemoryServer } from '../src/context_room.mjs';
import { registerContextHubProject } from '../src/context_hub.mjs';

async function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-legacy-doc-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), source = path.join(base, 'legacy'), snapshot = path.join(base, 'snapshot');
  fs.mkdirSync(root); fs.mkdirSync(source);
  execFileSync('python3', ['-B', '-c', `import sqlite3,sys,hashlib
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root TEXT); CREATE TABLE boards(id TEXT PRIMARY KEY,title TEXT,project TEXT,revision INTEGER); CREATE TABLE objects(board TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(board,id)); CREATE TABLE drafts(project TEXT,path TEXT,device TEXT,base TEXT,content TEXT,version INTEGER,PRIMARY KEY(project,path,device));')
 db.execute('INSERT INTO projects VALUES(?,?,?)',('original-project','Original project','/synthetic/original'))
 db.execute('INSERT INTO drafts VALUES(?,?,?,?,?,?)',('original-project','docs/Original.md','original-tablet',hashlib.sha256(b'Original document\\n').hexdigest(),'Retained draft 🖊️\\n',17))`, path.join(source, 'workspace.sqlite')], { stdio: 'pipe' });
  const exported = await exportLisiereSnapshot({ source, output: snapshot });
  await exportLisiereSnapshot({ source, output: snapshot, apply: true, expectedRevision: exported.revision });
  const selector = inspectLisiereSnapshot(snapshot, { kind: 'drafts' }).items[0].selector;
  const options = { snapshot, selector, path: 'docs/Recovered.md' };
  const authority = { canWrite: rel => rel.startsWith('docs/'), acceptedBase: () => null };
  const plan = () => migrateLisiereDocument(root, options, authority);
  const apply = revision => migrateLisiereDocument(root, { ...options, apply: true, expectedRevision: revision }, authority);
  return { base, root, source, snapshot, options, authority, plan, apply };
}

test('a retained Mac draft becomes an editing proposal with exact original text and no accepted or ordinary file', async t => {
  const f = await fixture(t), plan = f.plan(); assert.deepEqual(fs.readdirSync(f.root), []);
  assert.equal(plan.applied, false); assert.equal(plan.source.version, 17);
  const applied = f.apply(plan.revision); assert.equal(applied.accepted, false); assert.equal(applied.status, 'editing');
  assert.equal(fs.existsSync(path.join(f.root, f.options.path)), false);
  assert.equal(fs.readFileSync(path.join(applied.editRoot, f.options.path), 'utf8'), 'Retained draft 🖊️\n');
  const source = JSON.parse(fs.readFileSync(path.join(f.root, applied.recovery, 'source-draft.json')));
  assert.equal(source.device, 'original-tablet'); assert.equal(source.content, 'Retained draft 🖊️\n');
  fs.writeFileSync(path.join(applied.editRoot, f.options.path), 'Later human text');
  assert.equal(f.apply(plan.revision).proposalId, applied.proposalId);
  assert.equal(fs.readFileSync(path.join(applied.editRoot, f.options.path), 'utf8'), 'Later human text');
  assert.equal(listLocalProposals(f.root).length, 1);
  const submitted = submitLocalProposal(f.root, applied.proposalId); assert.equal(submitted.status, 'submitted');
  assert.equal(f.apply(plan.revision).status, 'submitted'); assert.equal(readLocalProposalFile(f.root, applied.proposalId, f.options.path).afterBytes.toString(), 'Later human text');
});

test('the original file must still match the legacy base, while accepted before bytes and current mode stay distinct', async t => {
  const f = await fixture(t); f.options.path = 'docs/Original.md'; fs.mkdirSync(path.join(f.root, 'docs'));
  const target = path.join(f.root, f.options.path); fs.writeFileSync(target, 'Original document\n'); fs.chmodSync(target, 0o600);
  assert.throws(f.plan, /no accepted review base/);
  f.authority.acceptedBase = () => ({ bytes: Buffer.from('Earlier accepted document\n'), mode: 0o644 });
  const plan = f.plan(); fs.writeFileSync(target, 'Newer original text'); assert.throws(() => f.apply(plan.revision), /changed since this draft/);
  fs.writeFileSync(target, 'Original document\n'); const imported = f.apply(plan.revision);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Original document\n'); assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(imported.editRoot, f.options.path)).mode & 0o777, 0o600);
  const submitted = submitLocalProposal(f.root, imported.proposalId), file = readLocalProposalFile(f.root, imported.proposalId, f.options.path);
  assert.equal(submitted.status, 'submitted'); assert.equal(file.beforeBytes.toString(), 'Earlier accepted document\n'); assert.equal(file.afterBytes.toString(), 'Retained draft 🖊️\n');
});

test('interrupted retention and proposal acknowledgement resume without duplicate proposals or lost human edits', async t => {
  for (const stage of ['retention', 'proposal', 'receipt']) {
    const f = await fixture(t), plan = f.plan(), link = fs.linkSync, rename = fs.renameSync; let interrupted = false;
    const stop = to => !interrupted && (stage === 'retention' && String(to).endsWith('/source-draft.json')
      || stage === 'proposal' && String(to).includes('/local-proposals/proposals/') && String(to).endsWith('.json')
      || stage === 'receipt' && String(to).endsWith('/applied.json'));
    fs.linkSync = (from, to, ...rest) => { link(from, to, ...rest); if (stop(to)) { interrupted = true; throw new Error('Lost recovery acknowledgement'); } };
    fs.renameSync = (from, to, ...rest) => { rename(from, to, ...rest); if (stop(to)) { interrupted = true; throw new Error('Lost recovery acknowledgement'); } };
    try { assert.throws(() => f.apply(plan.revision), /Lost recovery acknowledgement/); } finally { fs.linkSync = link; fs.renameSync = rename; }
    assert.equal(interrupted, true);
    const previous = listLocalProposals(f.root)[0];
    if (previous) fs.writeFileSync(path.join(previous.editRoot, f.options.path), 'Human edit after interruption');
    const applied = f.apply(plan.revision); assert.equal(listLocalProposals(f.root).length, 1);
    assert.equal(fs.readFileSync(path.join(applied.editRoot, f.options.path), 'utf8'), previous ? 'Human edit after interruption' : 'Retained draft 🖊️\n');
  }
});

test('an unchanged draft in a later full snapshot reuses its original preparation and preserves later accepted-base changes', async t => {
  const f = await fixture(t), plan = f.plan(), original = f.apply(plan.revision);
  execFileSync('python3', ['-B', '-c', "import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute(\"UPDATE projects SET name='Later project name'\")", path.join(f.source, 'workspace.sqlite')], { stdio: 'pipe' });
  const output = path.join(f.base, 'later-snapshot'), snapshot = await exportLisiereSnapshot({ source: f.source, output });
  await exportLisiereSnapshot({ source: f.source, output, apply: true, expectedRevision: snapshot.revision }); f.options.snapshot = output;
  f.authority.acceptedBase = () => { throw new Error('A published preparation must keep its original base'); };
  const next = f.plan(); assert.notEqual(next.revision, plan.revision); assert.equal(next.requestId, plan.requestId);
  assert.equal(f.apply(next.revision).proposalId, original.proposalId); assert.equal(listLocalProposals(f.root).length, 1);
  assert.equal(fs.readdirSync(path.join(f.root, original.recovery, 'sources')).length, 2);
});

test('CLI restores a selected draft using existing project permissions without submitting or accepting it', async t => {
  const f = await fixture(t); initializeContextRoomProject(f.root, { title: 'Recovery fixture', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
  const args = [cli, 'migrate', '--root', f.root, '--import-lisiere', f.snapshot, '--legacy-draft', f.options.selector, '--path', f.options.path];
  const options = { cwd: f.base, encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: f.base,
    CONTEXT_ROOM_HUB_HOME: path.join(f.base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(f.base, 'shared') } };
  const plan = JSON.parse(execFileSync(process.execPath, args, options)).data;
  const applied = JSON.parse(execFileSync(process.execPath, [...args, '--apply', '--revision', plan.revision], options)).data;
  assert.equal(applied.status, 'editing'); assert.equal(applied.accepted, false); assert.equal(fs.existsSync(path.join(f.root, f.options.path)), false);
  const mixed = spawnSync(process.execPath, [...args, '--legacy-board', 'board'], options);
  assert.notEqual(mixed.status, 0);
  const conflict = JSON.parse(mixed.stderr);
  assert.equal(conflict.error.code, 'invalid-arguments');
  assert.match(conflict.error.message, /Choose one legacy board, draft or conversation/);
});

test('owner HTTP draft actions keep origin, nonce, project and exact saved revision boundaries', async t => {
  let room;
  t.after(async () => { if (room) { await new Promise(resolve => { room.server.close(resolve); room.server.closeAllConnections?.(); }); await room.waitForShutdown(); } });
  const f = await fixture(t);
  const previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { previous[key] = process.env[key]; process.env[key] = path.join(f.base, key); }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  initializeContextRoomProject(f.root, { title: 'Draft owner', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  registerContextHubProject(f.root, { title: 'Draft owner' });
  const imported = f.apply(f.plan().revision); room = createMemoryServer({ root: f.root });
  await new Promise(resolve => room.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  for (const route of ['/api/context-hub', '/api/context-hub/catalog', '/api/context-hub/review-queue']) {
    const projection = await (await fetch(origin + route)).json();
    assert.ok(projection.workingDrafts.some(draft => draft.id === imported.proposalId), route);
    assert.equal((projection.items || []).some(item => item.proposalId === imported.proposalId), false);
  }
  const opened = await (await fetch(origin + '/api/docqa/local-draft?' + new URLSearchParams({ proposal: imported.proposalId, path: f.options.path }))).json();
  assert.equal(opened.status, 'editing');
  const input = { proposal: imported.proposalId, path: f.options.path, content: 'Owner saved text', expectedRevision: opened.revision };
  const post = async (route, data = input, headers = {}) => {
    const response = await fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json', origin,
      'x-context-room-owner-nonce': room.ownerMutationNonce, 'x-context-room-project': room.projectId, ...headers }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  const save = '/api/docqa/local-draft', submit = '/api/docqa/local-draft-submit';
  assert.equal((await post(save, input, { 'x-context-room-owner-nonce': '' })).status, 403);
  assert.equal((await post(submit, input, { 'x-context-room-owner-nonce': '' })).status, 403);
  assert.equal((await post(save, input, { origin: 'https://outside.example', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post(save, input, { 'x-context-room-project': 'wrong-project' })).status, 409);
  const saved = await post(save); assert.equal(saved.status, 200); assert.equal(saved.data.status, 'editing');
  assert.equal(fs.existsSync(path.join(f.root, f.options.path)), false);
  assert.equal((await post(save)).status, 409); assert.equal((await post(submit)).status, 409);
  assert.equal((await post(submit, { proposal: imported.proposalId })).status, 400);
  const submitted = await post(submit, { proposal: imported.proposalId, expectedRevision: saved.data.revision });
  assert.equal(submitted.status, 200); assert.equal(submitted.data.status, 'submitted');
  assert.equal(fs.existsSync(path.join(f.root, f.options.path)), false);
  assert.equal((await post(save, { ...input, expectedRevision: saved.data.revision })).status, 400);
  assert.equal(readLocalProposalFile(f.root, imported.proposalId, f.options.path).afterBytes.toString(), 'Owner saved text');
});
