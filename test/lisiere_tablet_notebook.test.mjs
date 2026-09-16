import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reconciliationFixture } from './fixtures/lisiere-reconciliation.mjs';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';
import { migrateLisiereReconciliation } from '../src/lisiere_reconcile.mjs';
import { readNotebook, mutateNotebook } from '../src/notebooks.mjs';

async function fixture(t, badAsset = false) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-tablet-scene-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = await reconciliationFixture(base), root = path.join(base, 'project'); fs.mkdirSync(root);
  const objects = [{ id: 'local-only-ink', type: 'ink', width: 3, points: [[20, 30, .5], [90, 80, 1]] },
    { id: 'local-tombstone', revision: 0, deleted: true }];
  if (badAsset) objects.push({ id: 'missing-image', type: 'image', assetId: '0'.repeat(64), x: 0, y: 0, w: 10, h: 10 });
  execFileSync('python3', ['-B', '-c', `import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE board_headers(board TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE board_objects(board TEXT,id TEXT,value TEXT,PRIMARY KEY(board,id));')
 db.execute('INSERT INTO board_headers VALUES(?,?)',('original-board',json.dumps({'id':'original-board','title':'Local free idea','revision':0,'project':None})))
 for item in json.loads(sys.argv[2]): db.execute('INSERT INTO board_objects VALUES(?,?,?)',('original-board',item['id'],json.dumps(item)))`, path.join(f.androidSource, 'workspace.sqlite'), JSON.stringify(objects)], { stdio: 'pipe' });
  const snapshot = path.join(base, 'tablet-snapshot'); const preview = await exportLisiereSnapshot({ source: f.androidSource, output: snapshot });
  await exportLisiereSnapshot({ source: f.androidSource, output: snapshot, apply: true, expectedRevision: preview.revision });
  return { ...f, root, androidSnapshot: snapshot, recoveryView: 'tablet', objects };
}
const canWrite = rel => rel.startsWith('docs/');

test('a retained tablet scene cannot disappear behind queue reconciliation; explicit tablet copy preserves local-only ink and maps revisions without a Mac acknowledgement', async t => {
  const f = await fixture(t), original = fs.readFileSync(path.join(f.androidSource, 'workspace.sqlite'));
  const undecided = migrateLisiereReconciliation(f.root, { ...f, recoveryView: undefined }, { canWrite });
  assert.equal(undecided.blocked, true); assert.equal(undecided.needsCacheChoice, true); assert.deepEqual(undecided.choices, ['queue', 'tablet']);
  assert.throws(() => migrateLisiereReconciliation(f.root, { ...f, recoveryView: undefined, apply: true, expectedRevision: undecided.revision }, { canWrite }), /Unresolved/);
  const plan = migrateLisiereReconciliation(f.root, f, { canWrite }); assert.equal(plan.blocked, false); assert.equal(plan.delivery, 'not-inferred');
  assert.equal(fs.existsSync(path.join(f.root, '.context-room')), false);
  const imported = migrateLisiereReconciliation(f.root, { ...f, apply: true, expectedRevision: plan.revision }, { canWrite });
  const scene = readNotebook(f.root, imported.resourceId);
  assert.equal(scene.document.title, 'Local free idea'); assert.equal(scene.document.objects.length, 1);
  assert.deepEqual(scene.document.objects[0].points, f.objects[0].points); assert.equal(scene.tombstones['local-tombstone'], 1);
  assert.equal(scene.document.objects[0].createdBy.kind, 'import'); assert.equal(fs.existsSync(path.join(f.root, f.path)), false);
  mutateNotebook(f.root, { protocolVersion: 1, resourceId: scene.resourceId, operationId: 'recent-human', locationRevision: scene.locator.revision,
    edits: [{ id: 'recent', kind: 'put', expectedRevision: 0, object: { type: 'text', text: 'Keep recent', x: 1, y: 20 } }] }, { canWrite, actor: { kind: 'human', id: 'fixture' } });
  assert.equal(migrateLisiereReconciliation(f.root, { ...f, apply: true, expectedRevision: plan.revision }, { canWrite }).replayed, true);
  assert.equal(readNotebook(f.root, scene.resourceId).document.objects.length, 2);
  assert.deepEqual(fs.readFileSync(path.join(f.androidSource, 'workspace.sqlite')), original);
  const queue = migrateLisiereReconciliation(f.root, { ...f, path: 'docs/Queue.crnb', recoveryView: 'queue' }, { canWrite });
  assert.equal(queue.blocked, false); assert.notEqual(queue.resourceId, scene.resourceId);
});

test('an absent original raster blocks the tablet copy instead of inventing a placeholder', async t => {
  const f = await fixture(t, true), plan = migrateLisiereReconciliation(f.root, f, { canWrite });
  assert.equal(plan.blocked, true); assert.match(plan.conversionError.message, /asset|image/i);
  assert.equal(fs.existsSync(path.join(f.root, '.context-room')), false);
});
