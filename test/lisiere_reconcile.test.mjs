import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reconciliationFixture } from './fixtures/lisiere-reconciliation.mjs';
import { migrateLisiereReconciliation } from '../src/lisiere_reconcile.mjs';
import { listNotebooks, readNotebook, mutateNotebook } from '../src/notebooks.mjs';
import { notebookHash } from '../src/notebook_io.mjs';

function folder(t) { const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-reconcile-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base; }
const authority = { canWrite: rel => rel.startsWith('docs/') };

test('exact Python receipt semantics, lost response, successor chain, undo, metadata, binary and conflicts', () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('./python/lisiere_reconcile_test.py', import.meta.url))], { stdio: 'pipe', timeout: 30000 });
});

test('real SQLite exports reconcile into a separate working scene with exact mapping and no legacy write', async t => {
  const base = folder(t), f = await reconciliationFixture(base), root = path.join(base, 'project'); fs.mkdirSync(root);
  const originals = [f.macSource, f.androidSource].map(p => fs.readFileSync(path.join(p, 'workspace.sqlite')));
  const plan = migrateLisiereReconciliation(root, f, authority);
  assert.equal(plan.blocked, false); assert.equal(plan.applied, false); assert.equal(fs.existsSync(path.join(root, '.context-room')), false);
  assert.deepEqual(plan.operations.map(row => row.status), ['receipt-matched', 'pending-compatible', 'pending-compatible']);
  assert.deepEqual(plan.revisionMapping.map(row => row.effectiveExpected), [1, 3]);
  assert.equal(plan.operations[0].seq, '9007199254740993');
  const apply = { ...f, apply: true, expectedRevision: plan.revision };
  const imported = migrateLisiereReconciliation(root, apply, authority);
  assert.equal(imported.accepted, false); assert.equal(imported.legacyQueueChanged, false);
  assert.equal(fs.existsSync(path.join(root, f.path)), false); assert.equal(listNotebooks(root).length, 1);
  const state = readNotebook(root, imported.resourceId);
  assert.equal(state.document.objects.find(o => o.id === 'shape').x, 80);
  assert.equal(state.document.objects.find(o => o.id === 'mac-independent').text, 'Independent Mac work');
  assert.ok(state.document.objects.every(o => o.createdBy.kind === 'import'));
  assert.deepEqual([f.macSource, f.androidSource].map(p => fs.readFileSync(path.join(p, 'workspace.sqlite'))), originals);
  mutateNotebook(root, { protocolVersion: 1, resourceId: state.resourceId, operationId: 'later-human', locationRevision: state.locator.revision,
    edits: [{ kind: 'put', id: 'later', expectedRevision: 0, object: { type: 'text', x: 40, y: 80, text: 'Keep recent work' } }] }, { ...authority, actor: { kind: 'human', id: 'person' } });
  const repeated = migrateLisiereReconciliation(root, apply, authority);
  assert.equal(repeated.replayed, true); assert.equal(readNotebook(root, state.resourceId).document.objects.length, 3);
});

test('interrupted import resumes without changing newer work; stale scope, snapshot and occupied destination refuse', async t => {
  const base = folder(t), f = await reconciliationFixture(base), root = path.join(base, 'project'); fs.mkdirSync(root);
  const plan = migrateLisiereReconciliation(root, f, authority), apply = { ...f, apply: true, expectedRevision: plan.revision };
  assert.throws(() => migrateLisiereReconciliation(root, apply, { ...authority, checkpoint: phase => { if (phase === 'imported') throw new Error('Synthetic lost acknowledgement'); } }), /Synthetic/);
  const scene = readNotebook(root, plan.resourceId), hash = notebookHash(scene.document);
  assert.equal(migrateLisiereReconciliation(root, apply, authority).replayed, true);
  assert.equal(notebookHash(readNotebook(root, plan.resourceId).document), hash);
  assert.throws(() => migrateLisiereReconciliation(root, apply, { canWrite: () => false }), /permissions changed|Unresolved/);
  assert.throws(() => migrateLisiereReconciliation(root, { ...apply, expectedRevision: '0'.repeat(64) }, authority), /changed after/);
  const otherRoot = path.join(base, 'occupied'); fs.mkdirSync(path.join(otherRoot, 'docs'), { recursive: true }); fs.writeFileSync(path.join(otherRoot, f.path), 'Independent file');
  const occupied = migrateLisiereReconciliation(otherRoot, f, authority); assert.equal(occupied.blocked, true);
  assert.equal(fs.readFileSync(path.join(otherRoot, f.path), 'utf8'), 'Independent file');
});

test('installed migration CLI compares exact snapshots and imports only a previewed working scene', async t => {
  const { initializeContextRoomProject, writeMemoryWebappSettings } = await import('../src/context_room.mjs');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-reconciliation-cli-'))), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) {
    previous[key] = process.env[key]; process.env[key] = path.join(base, key);
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(base, { recursive: true, force: true }); });
  const f = await reconciliationFixture(base), root = path.join(base, 'project'); fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  initializeContextRoomProject(root, { allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
  const run = extra => JSON.parse(execFileSync(process.execPath, [cli, 'migrate', '--reconcile-lisiere', f.androidSnapshot,
    '--mac-snapshot', f.macSnapshot, '--legacy-actor', 'tablet', '--legacy-board', 'original-board', '--path', 'docs/Recovered.crnb', ...extra],
    { cwd: root, env: { ...process.env, HOME: base }, encoding: 'utf8', timeout: 45000, stdio: 'pipe' }));
  const plan = run([]); assert.equal(plan.ok, true); assert.equal(plan.data.blocked, false); assert.equal(plan.data.applied, false);
  const applied = run(['--apply', '--revision', plan.data.revision]); assert.equal(applied.data.applied, true); assert.equal(applied.data.accepted, false);
  assert.equal(run(['--apply', '--revision', plan.data.revision]).data.replayed, true);
  assert.equal(readNotebook(root, applied.data.resourceId).document.objects.find(o => o.id === 'shape').x, 80);
  assert.equal(fs.existsSync(path.join(root, 'docs/Recovered.crnb')), false);
});
