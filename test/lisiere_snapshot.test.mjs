import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';

test('real legacy SQLite snapshots preserve recovery data, omit credentials and reject stale or unsafe exports', () => {
  const script = fileURLToPath(new URL('./python/lisiere_snapshot_test.py', import.meta.url));
  let output;
  try { output = execFileSync('python3', ['-B', script], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: 'pipe' }); }
  catch (error) { throw new Error('Legacy SQLite contract failure:\n' + error.stdout + '\n' + error.stderr, { cause: error }); }
  assert.match(output, /9 legacy snapshot contracts passed/);
});

test('installed CLI previews and resumes a private SQLite export without a registered project or old executable', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-snapshot-cli-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'old workspace'), output = path.join(base, 'recovery');
  fs.mkdirSync(source, { mode: 0o700 });
  execFileSync('python3', ['-B', '-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,operation TEXT,args TEXT,error TEXT);')
 db.execute('INSERT INTO cache VALUES(?,?)', ('draftdoc:project:Idea.md', 'Original unsent draft 🖊️'))`, path.join(source, 'workspace.sqlite')]);
  const database = fs.readFileSync(path.join(source, 'workspace.sqlite'));
  const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
  const options = { cwd: base, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: base, CONTEXT_ROOM_HUB_HOME: path.join(base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(base, 'shared') } };
  const run = extra => JSON.parse(execFileSync(process.execPath, [cli, 'migrate', '--export-lisiere', source, '--output', output, ...extra], options));
  const preview = run([]);
  assert.equal(preview.ok, true);
  assert.equal(preview.data.exported, false);
  assert.equal(preview.data.kind, 'android-workspace');
  assert.equal(run(['--plan']).data.revision, preview.data.revision);
  assert.equal(fs.existsSync(output), false);
  const applied = run(['--apply', '--revision', preview.data.revision]);
  assert.equal(applied.ok, true); assert.equal(applied.data.exported, true); assert.equal(applied.data.accepted, false);
  const manifest = fs.readFileSync(path.join(output, 'manifest.json'));
  assert.equal(run(['--apply', '--revision', preview.data.revision]).data.revision, preview.data.revision);
  assert.deepEqual(fs.readFileSync(path.join(output, 'manifest.json')), manifest);
  assert.deepEqual(fs.readFileSync(path.join(source, 'workspace.sqlite')), database);
  assert.match(fs.readFileSync(path.join(output, 'tables/cache.jsonl'), 'utf8'), /Original unsent draft 🖊️/u);
  assert.equal(fs.existsSync(path.join(base, '.context-room')), false);
  await assert.rejects(exportLisiereSnapshot({ source, output, apply: true }), { code: 'migration_revision' });
  await assert.rejects(exportLisiereSnapshot({ source, output, apply: true, expectedRevision: '0'.repeat(64) }), /changed after/);
  await assert.rejects(exportLisiereSnapshot({ source: true, output }), { code: 'migration_arguments' });
});
