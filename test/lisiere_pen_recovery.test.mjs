import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';
import { migrateLisiereReconciliation } from '../src/lisiere_reconcile.mjs';
import { readNotebook, mutateNotebook } from '../src/notebooks.mjs';

const helper = fileURLToPath(new URL('./python/lisiere_pen_recovery_test.py', import.meta.url));
const authority = { canWrite: p => p.startsWith('docs/') };
async function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pen-recovery-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  execFileSync('python3', ['-B', helper, '--fixture', base], { stdio: 'pipe' });
  const snapshots = {};
  for (const name of ['mac', 'android']) {
    const source = path.join(base, name), output = path.join(base, name + '-snapshot');
    const plan = await exportLisiereSnapshot({ source, output });
    await exportLisiereSnapshot({ source, output, apply: true, expectedRevision: plan.revision });
    snapshots[name] = output;
  }
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  return { base, root, options: { macSnapshot: snapshots.mac, androidSnapshot: snapshots.android,
    boardId: 'board', actor: 'tablet', path: 'docs/Retained.crnb' } };
}

test('historical progressive jobs: committed frames, crash windows, exact undo and conflicting requests', t => {
  const result = spawnSync('python3', ['-B', helper], { encoding: 'utf8', timeout: 30000 });
  t.diagnostic(result.stderr);
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('SQLite export to recovered notebook keeps reached points and frame evidence, never an unexecuted tail', async t => {
  const { base, root, options } = await fixture(t);
  const originals = ['mac', 'android'].map(n => fs.readFileSync(path.join(base, n, 'workspace.sqlite')));
  const preview = migrateLisiereReconciliation(root, options, authority);
  assert.equal(preview.blocked, false);
  assert.equal(preview.penRecovery.jobs[0].descriptor, 'lagging-one-committed-frame');
  assert.equal(fs.existsSync(path.join(root, '.context-room')), false);
  const apply = { ...options, apply: true, expectedRevision: preview.revision };
  assert.throws(() => migrateLisiereReconciliation(root, apply, { ...authority, checkpoint: phase => {
    if (phase === 'imported') throw new Error('Synthetic lost acknowledgement');
  } }), /Synthetic lost acknowledgement/);
  const current = readNotebook(root, preview.resourceId);
  assert.deepEqual(current.document.objects.find(o => o.id === 'ink').points, [[0, 0, 1], [25, 0, .5]]);
  assert.equal(current.document.objects.length, 2);
  assert.equal(current.document.objects[0].createdBy.kind, 'import');
  assert.equal(fs.existsSync(path.join(root, options.path)), false);
  const records = JSON.parse(fs.readFileSync(path.join(root, preview.recovery, 'original-records.json')));
  assert.equal(records.mac.pen_jobs.length, 1); assert.equal(records.mac.history[0].id, 'pen:gesture');
  assert.equal(records.mac.events.length, 2);
  assert.equal(records.mac.events[0].seq.integer, '9007199254740993');
  mutateNotebook(root, { protocolVersion: 1, resourceId: current.resourceId, locationRevision: current.locator.revision,
    operationId: 'new-human', edits: [{ kind: 'put', id: 'human', expectedRevision: 0, object: { type: 'text', text: 'Recent work', x: 40, y: 30 } }] },
  { ...authority, actor: { kind: 'human', id: 'owner' } });
  assert.equal(migrateLisiereReconciliation(root, apply, authority).replayed, true);
  assert.equal(readNotebook(root, current.resourceId).document.objects.length, 3);
  assert.deepEqual(['mac', 'android'].map(n => fs.readFileSync(path.join(base, n, 'workspace.sqlite'))), originals);
  assert.equal(current.accepted, false);
});

test('a damaged frame chain blocks the real import and leaves both sources and destination intact', async t => {
  const { base, root, options } = await fixture(t);
  execFileSync('python3', ['-B', '-c', 'import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute("DELETE FROM events WHERE seq=(SELECT MIN(seq) FROM events)")', path.join(base, 'mac/workspace.sqlite')]);
  const output = path.join(base, 'damaged-snapshot'), source = path.join(base, 'mac');
  const snapshot = await exportLisiereSnapshot({ source, output });
  await exportLisiereSnapshot({ source, output, apply: true, expectedRevision: snapshot.revision });
  const preview = migrateLisiereReconciliation(root, { ...options, macSnapshot: output }, authority);
  assert.equal(preview.blocked, true);
  assert.equal(preview.penRecovery.jobs[0].reason, 'pen-frame-gap-or-duplicate');
  assert.throws(() => migrateLisiereReconciliation(root, { ...options, macSnapshot: output, apply: true, expectedRevision: preview.revision }, authority), /Unresolved/);
  assert.equal(fs.existsSync(path.join(root, '.context-room')), false);
});
