import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { reconciliationFixture } from './fixtures/lisiere-reconciliation.mjs';
import { planLisiereCutover, applyLisiereCutover, changeCutoverMode, expectedLegacyLabel } from '../src/lisiere_cutover.mjs';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';
import { assertProjectWriter, projectWriterAuthority } from '../src/writer_authority.mjs';
import { openNotebook, mutateNotebook, readNotebook } from '../src/notebooks.mjs';

async function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-writer-cutover-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = await reconciliationFixture(base); fs.chmodSync(f.macSource, 0o700);
  const root = path.join(base, 'project'); fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.context-room'), { recursive: true });
  fs.writeFileSync(path.join(root, '.context-room/config.json'), '{"customHub":{"title":"Keep custom sections"}}');
  fs.writeFileSync(path.join(root, 'docs/guide.md'), '# Accepted original\n');
  fs.writeFileSync(path.join(f.macSource, 'synthetic-preferences'), 'Synthetic retained settings, not an actual credential');
  const service = { label: 'fr.lisiere.companion', plistSha256: 'a'.repeat(64), source: f.macSource, uid: process.getuid() };
  let stops = 0;
  const adapters = { inspectLegacy: () => service, stopLegacy: () => { stops++; return { ...service, disabled: true, stopped: true }; },
    verifyLegacy: () => ({ ...service, disabled: true, stopped: true }) };
  return { ...f, root, base, options: { legacySource: f.macSource, macSnapshot: f.macSnapshot, legacyPlist: path.join(base, 'synthetic-launch-agent.plist') },
    adapters, stops: () => stops };
}

const edit = (root, scene, id) => mutateNotebook(root, { protocolVersion: 1, resourceId: scene.resourceId,
  operationId: id, locationRevision: scene.locator.revision, edits: [{ kind: 'put', id, expectedRevision: 0, object: { type: 'text', text: id, x: 20, y: 60 } }] },
  { canWrite: () => true, actor: { kind: 'human', id: 'synthetic-person' } });

test('single-writer cutover retains the full original, fences old SQLite, and rollback preserves newer documents and notebook gestures', async t => {
  const f = await fixture(t), bytes = fs.readFileSync(path.join(f.macSource, 'workspace.sqlite')), config = fs.readFileSync(path.join(f.root, '.context-room/config.json'));
  const notebook = openNotebook(f.root, { path: 'docs/Idea.crnb', canWrite: () => true });
  const plan = await planLisiereCutover(f.root, f.options, f.adapters); assert.equal(f.stops(), 0); assert.equal(plan.completed, false);
  assert.equal(projectWriterAuthority(f.root).mode, 'unmanaged');
  const applied = await applyLisiereCutover(f.root, { ...f.options, expectedRevision: plan.revision }, f.adapters);
  assert.equal(applied.mode, 'context-room'); assert.equal(applied.legacyQueueResumed, false); assert.equal(applied.accepted, false);
  assert.deepEqual(fs.readFileSync(path.join(applied.backup, 'workspace.sqlite')), bytes);
  assert.equal(fs.readFileSync(path.join(applied.backup, 'synthetic-preferences'), 'utf8'), 'Synthetic retained settings, not an actual credential');
  assert.throws(() => execFileSync('python3', ['-B', '-c', 'import sqlite3,sys;sqlite3.connect(sys.argv[1])', path.join(f.macSource, 'workspace.sqlite')], { stdio: 'pipe' }), /unable to open database file/);
  edit(f.root, notebook, 'newer-human-gesture'); fs.writeFileSync(path.join(f.root, 'docs/guide.md'), '# Newer independent document\n');
  const rollback = await changeCutoverMode(f.root), paused = await changeCutoverMode(f.root, { apply: true, expectedRevision: rollback.revision });
  assert.equal(paused.mode, 'paused'); assert.equal(paused.dataRestored, false);
  assert.equal((await changeCutoverMode(f.root, { apply: true, expectedRevision: rollback.revision })).replayed, true);
  assert.throws(() => edit(f.root, notebook, 'blocked-gesture'), { code: 'migration_writer_paused' });
  assert.equal(readNotebook(f.root, notebook.resourceId).document.objects.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.context-room/config.json')), config);
  assert.equal(fs.readFileSync(path.join(f.root, 'docs/guide.md'), 'utf8'), '# Newer independent document\n');
  const resume = await changeCutoverMode(f.root, { resume: true }, f.adapters); await changeCutoverMode(f.root, { resume: true, apply: true, expectedRevision: resume.revision }, f.adapters);
  await assert.rejects(changeCutoverMode(f.root, { apply: true, expectedRevision: rollback.revision }), /generation changed/);
  edit(f.root, notebook, 'next-human-gesture'); assert.equal(readNotebook(f.root, notebook.resourceId).document.objects.length, 2);
  assert.equal((await applyLisiereCutover(f.root, { ...f.options, expectedRevision: plan.revision }, f.adapters)).replayed, true);
  assert.equal(f.stops(), 1);
  fs.renameSync(f.macSource, f.macSource + '-moved-fence'); fs.mkdirSync(f.macSource);
  assert.throws(() => assertProjectWriter(f.root), { code: 'migration_writer_paused' });
});

test('cutover accepts a synthetic legacy label only with the matching test nonce', async t => {
  const f = await fixture(t), previous = process.env.CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT;
  t.after(() => { if (previous === undefined) delete process.env.CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT; else process.env.CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT = previous; });
  const label = 'test.contextroom.synthetic-abc123def456';
  const as = shown => ({ ...f.adapters, inspectLegacy: () => ({ label: shown, plistSha256: 'a'.repeat(64), synthetic: shown !== 'fr.lisiere.companion' }) });
  assert.equal(expectedLegacyLabel({}), 'fr.lisiere.companion');
  delete process.env.CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT;
  await assert.rejects(planLisiereCutover(f.root, f.options, as(label)), /Unrecognized legacy service/);
  process.env.CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT = 'abc123def456';
  const plan = await planLisiereCutover(f.root, f.options, as(label));
  assert.equal(plan.service.label, label); assert.equal(plan.service.synthetic, true);
  await assert.rejects(planLisiereCutover(f.root, f.options, as('fr.lisiere.companion')), /Unrecognized legacy service/);
  process.env.CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT = 'other000nonce';
  await assert.rejects(planLisiereCutover(f.root, f.options, as(label)), /Unrecognized legacy service/);
  process.env.CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT = 'BAD';
  await assert.rejects(planLisiereCutover(f.root, f.options, as(label)), /nonce/);
  assert.equal(projectWriterAuthority(f.root).mode, 'unmanaged'); assert.equal(f.stops(), 0);
});

test('resume after a functional rollback refuses a running legacy writer and newer retained work until acknowledged', async t => {
  const f = await fixture(t), plan = await planLisiereCutover(f.root, f.options, f.adapters);
  const applied = await applyLisiereCutover(f.root, { ...f.options, expectedRevision: plan.revision }, f.adapters);
  const rollback = await changeCutoverMode(f.root); await changeCutoverMode(f.root, { apply: true, expectedRevision: rollback.revision });
  const staging = f.macSource + '.context-room-fence-' + plan.revision.slice(0, 16);
  // Functional return to Lisière: the fence moves aside and the original returns, then new work lands.
  fs.renameSync(f.macSource, staging); fs.renameSync(applied.backup, f.macSource);
  let running = true; const adapters = { verifyLegacy: () => ({ stopped: !running, disabled: !running }) };
  await assert.rejects(changeCutoverMode(f.root, { resume: true }, adapters), /Restore the original fence/);
  execFileSync('python3', ['-B', '-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db: db.execute("INSERT INTO boards VALUES('lisiere-after-rollback','Made under Lisiere',NULL,NULL,1,'')")`, path.join(f.macSource, 'workspace.sqlite')]);
  fs.renameSync(f.macSource, applied.backup); fs.renameSync(staging, f.macSource);
  await assert.rejects(changeCutoverMode(f.root, { resume: true }, adapters), /running again/);
  running = false;
  await assert.rejects(changeCutoverMode(f.root, { resume: true }, adapters), /newer work/);
  await assert.rejects(changeCutoverMode(f.root, { resume: true, macSnapshot: f.macSnapshot }, adapters), /exact export/);
  const newer = path.join(f.base, 'retained-export'), exported = await exportLisiereSnapshot({ source: applied.backup, output: newer });
  await exportLisiereSnapshot({ source: applied.backup, output: newer, apply: true, expectedRevision: exported.revision });
  await assert.rejects(changeCutoverMode(f.root, { macSnapshot: newer }), /only to acknowledge/);
  const resume = await changeCutoverMode(f.root, { resume: true, macSnapshot: newer }, adapters);
  assert.deepEqual(resume.acknowledged, { snapshot: newer, revision: exported.revision });
  assert.equal(projectWriterAuthority(f.root).mode, 'paused');
  const done = await changeCutoverMode(f.root, { resume: true, macSnapshot: newer, apply: true, expectedRevision: resume.revision }, adapters);
  assert.equal(done.mode, 'context-room'); assertProjectWriter(f.root);
  const journal = JSON.parse(fs.readFileSync(path.join(f.root, '.context-room/migrations/writer-v1', plan.revision + '.json'), 'utf8'));
  assert.deepEqual(journal.acknowledged, [{ snapshot: newer, revision: exported.revision }]);
  const again = await changeCutoverMode(f.root); await changeCutoverMode(f.root, { apply: true, expectedRevision: again.revision });
  const plain = await changeCutoverMode(f.root, { resume: true }, adapters); assert.equal(plain.acknowledged, undefined);
});

for (const phase of ['writers-paused', 'source-retired', 'fence-published']) test(`cutover resumes an interruption at ${phase}, with no unfenced Context Room writes`, async t => {
  const f = await fixture(t), plan = await planLisiereCutover(f.root, f.options, f.adapters), apply = { ...f.options, expectedRevision: plan.revision };
  await assert.rejects(applyLisiereCutover(f.root, apply, { ...f.adapters, checkpoint: at => { if (at === phase) throw new Error('Synthetic power loss'); } }), /Synthetic/);
  assert.throws(() => assertProjectWriter(f.root), { code: 'migration_writer_paused' });
  const resumed = await applyLisiereCutover(f.root, apply, f.adapters); assert.equal(resumed.completed, true);
  assert.equal(fs.lstatSync(path.join(f.macSource, 'workspace.sqlite')).isDirectory(), true);
});

test('an open SQLite connection blocks retirement; wrong preview and occupied destinations never replace data', async t => {
  const f = await fixture(t), plan = await planLisiereCutover(f.root, f.options, f.adapters);
  const child = spawn('python3', ['-B', '-u', '-c', `import sqlite3,sys
connection=sqlite3.connect(sys.argv[1]); connection.execute('SELECT * FROM boards').fetchall(); print('open',flush=True); sys.stdin.read()`, path.join(f.macSource, 'workspace.sqlite')], { stdio: ['pipe', 'pipe', 'pipe'] });
  await once(child.stdout, 'data');
  try { await assert.rejects(applyLisiereCutover(f.root, { ...f.options, expectedRevision: plan.revision }, f.adapters), /file is open/); }
  finally { child.stdin.end(); await once(child, 'exit'); }
  assert.equal(fs.statSync(path.join(f.macSource, 'workspace.sqlite')).isFile(), true);
  await assert.rejects(applyLisiereCutover(f.root, { ...f.options, expectedRevision: '0'.repeat(64) }, f.adapters), /changed after/);
  const backup = f.macSource + '.context-room-retired-' + plan.revision.slice(0, 16); fs.mkdirSync(backup); fs.writeFileSync(path.join(backup, 'human.txt'), 'Keep independent occupant');
  await assert.rejects(applyLisiereCutover(f.root, { ...f.options, expectedRevision: plan.revision }, f.adapters), /replaced/);
  assert.equal(fs.readFileSync(path.join(backup, 'human.txt'), 'utf8'), 'Keep independent occupant');
});

test('exclusive directory publication refuses even an empty newer destination', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-no-replace-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), target = path.join(base, 'target'); fs.mkdirSync(source); fs.mkdirSync(target); const inode = fs.statSync(target).ino;
  const script = fileURLToPath(new URL('../src/exclusive_rename.py', import.meta.url));
  assert.throws(() => execFileSync('python3', ['-B', script, source, target], { stdio: 'pipe' }), /File exists/);
  assert.equal(fs.statSync(target).ino, inode); assert.equal(fs.existsSync(source), true);
});

test('macOS shutdown adapter validates only the original service and refuses unknown states without starting anything', () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('./python/mac_legacy_quiescence_test.py', import.meta.url))], { stdio: 'pipe', timeout: 15000 });
});

test('paused owner HTTP refuses notebook and document writes while readback and agent stop remain available', async t => {
  const { assistantFixture } = await import('./fixtures/assistant.mjs');
  const { writeNotebookJson } = await import('../src/notebook_io.mjs');
  const { canonicalNotebookRoot } = await import('../src/notebook_io.mjs');
  const { WRITER_AUTHORITY } = await import('../src/writer_authority.mjs');
  const f = await assistantFixture(); t.after(() => f.close());
  const conversation = (await f.post('/api/assistant/conversations', { source: { kind: 'document', path: 'docs/Original.md' } })).body;
  const original = fs.readFileSync(path.join(f.root, 'docs/Original.md'));
  writeNotebookJson(f.root, WRITER_AUTHORITY, { version: 1, migrationId: 'a'.repeat(64), rootIdentity: canonicalNotebookRoot(f.root), generation: 1, mode: 'paused' });
  assert.equal((await f.post('/api/notebooks/open', { path: 'docs/Blocked.crnb', protocolVersion: 1 })).status, 409);
  assert.equal((await f.post('/api/file', { path: 'docs/Original.md', content: 'Must not replace' })).status, 409);
  assert.equal((await f.post('/api/assistant/conversations/' + conversation.id + '/stop', {})).status, 200);
  assert.equal((await fetch(f.url + '/api/assistant/conversations/' + conversation.id)).status, 200);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'docs/Original.md')), original); assert.equal(f.connections(), 0);
});

test('writer diagnostics remain readable after a pause and missing authority never re-enables an enrolled writer', async t => {
  const { assistantFixture } = await import('./fixtures/assistant.mjs');
  const { writeNotebookJson, canonicalNotebookRoot } = await import('../src/notebook_io.mjs');
  const { WRITER_AUTHORITY, inspectProjectWriter } = await import('../src/writer_authority.mjs');
  const { buildContextRoomDoctorReport } = await import('../src/context_room.mjs');
  const f = await assistantFixture(); t.after(() => f.close());
  const paused = { version: 1, rootIdentity: canonicalNotebookRoot(f.root), migrationId: 'b'.repeat(64), generation: 1, mode: 'paused' };
  writeNotebookJson(f.root, WRITER_AUTHORITY, paused);
  const report = buildContextRoomDoctorReport(f.root);
  assert.equal(report.runtimeDependencies.writerAuthority.mode, 'paused');
  assert.equal(report.issues.some(issue => issue.type === 'migration_writer_paused'), true);
  writeNotebookJson(f.root, '.context-room/migrations/writer-v1/' + paused.migrationId + '.json', { version: 1 });
  fs.unlinkSync(path.join(f.root, WRITER_AUTHORITY));
  assert.equal(inspectProjectWriter(f.root).writable, false);
  assert.throws(() => assertProjectWriter(f.root), /authority is missing/);
});
