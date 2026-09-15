import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planStateMigration, applyStateMigration } from '../src/state_migration.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.context-room'));
  fs.writeFileSync(path.join(root, '.context-room/config.json'), '{"allowedPaths":["docs/"],"customExtension":{"keep":true}}\n');
  fs.writeFileSync(path.join(root, '.context-room/review-state.json'), '{"reviews":{"docs/a.md":{"status":"needs_changes"}}}');
  return root;
}
test('migration backs up exact legacy bytes without promoting old pending evidence and is idempotent', t => {
  const root = fixture(t), plan = planStateMigration(root);
  assert.equal(plan.warnings.length, 1);
  assert.equal(fs.existsSync(path.join(root, '.context-room/workflow-state.json')), false);
  const result = applyStateMigration(root, { expectedRevision: plan.revision });
  assert.equal(result.migrated, true);
  for (const item of plan.files) assert.deepEqual(fs.readFileSync(path.join(root, item.path)), fs.readFileSync(path.join(root, result.backup, 'objects', item.hash)));
  const marker = fs.readFileSync(path.join(root, '.context-room/workflow-state.json'));
  assert.equal(applyStateMigration(root).idempotent, true);
  assert.deepEqual(fs.readFileSync(path.join(root, '.context-room/workflow-state.json')), marker);
});
test('stale migration preview refuses changed state and an interrupted completion journal can recover', t => {
  const root = fixture(t), plan = planStateMigration(root), config = path.join(root, '.context-room/config.json');
  fs.appendFileSync(config, '\n');
  assert.throws(() => applyStateMigration(root, { expectedRevision: plan.revision }), /changed after migration preview/);
  const fresh = planStateMigration(root), originalRename = fs.renameSync;
  let journalWrites = 0;
  fs.renameSync = (...args) => { if (String(args[1]).endsWith('/journal.json') && ++journalWrites === 2) throw new Error('Simulated completion crash'); return originalRename(...args); };
  try { assert.throws(() => applyStateMigration(root, { expectedRevision: fresh.revision }), /Simulated completion crash/); } finally { fs.renameSync = originalRename; }
  assert.equal(applyStateMigration(root).idempotent, true);
  const journal = JSON.parse(fs.readFileSync(path.join(root, '.context-room/migrations/workflow-v1/journal.json')));
  assert.equal(journal.status, 'complete'); assert.equal(journal.recovered, true);
});
test('migration refuses symbolic control files', t => {
  const root = fixture(t), file = path.join(root, '.context-room/config.json');
  fs.renameSync(file, file + '.old'); fs.symlinkSync(file + '.old', file);
  assert.throws(() => planStateMigration(root), /symbolic/);
});
test('the actual CLI permits exact-revision apply and refuses simultaneous plan/apply', t => {
  const root = fixture(t), cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
  const env = { ...process.env, HOME: root, CONTEXT_ROOM_HUB_HOME: path.join(root, 'isolated-hub'), CONTEXT_ROOM_SHARED_HOME: path.join(root, 'isolated-shared') };
  const run = args => JSON.parse(execFileSync(process.execPath, [cli, 'migrate', '--root', root, ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000, stdio: 'pipe' }));
  const original = fs.readFileSync(path.join(root, '.context-room/config.json'));
  const preview = run(['--plan']);
  assert.equal(preview.ok, true); assert.equal(preview.data.migrated, false);
  assert.throws(() => run(['--plan', '--apply', '--revision', preview.data.revision]), /Choose a migration preview/);
  const applied = run(['--apply', '--revision', preview.data.revision]);
  assert.equal(applied.data.migrated, true);
  assert.deepEqual(fs.readFileSync(path.join(root, '.context-room/config.json')), original);
  assert.equal(run(['--apply', '--revision', preview.data.revision]).data.idempotent, true);
});
