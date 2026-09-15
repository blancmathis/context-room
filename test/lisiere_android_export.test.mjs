import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';
import { readLisiereSnapshot } from '../src/lisiere_archive.mjs';
import { inspectLisiereSnapshot } from '../src/lisiere_inventory.mjs';
import { notebookHash } from '../src/notebook_io.mjs';

const script = fileURLToPath(new URL('./python/lisiere_android_export_test.py', import.meta.url));
const options = { encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024, stdio: 'pipe' };

test('native ZIP security, SQLite recovery, typed arguments and killed publication use real bounded files', () => {
  let output;
  try { output = execFileSync('python3', ['-B', script], options); }
  catch (error) { throw new Error('Android ZIP contract failure:\n' + error.stdout + '\n' + error.stderr, { cause: error }); }
  assert.match(output, /18 Android ZIP contracts passed/);
});

test('native ZIP conversion feeds the real inventory without acknowledging or losing exact Android arguments', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-android-export-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const fixture = JSON.parse(execFileSync('python3', ['-B', script, '--fixture', path.join(base, 'fixture')], options));
  const source = fixture.archive, output = path.join(base, 'snapshot');
  const preview = await exportLisiereSnapshot({ source, output });
  assert.equal(preview.version, 3); assert.equal(preview.accepted, false); assert.equal(preview.exported, false);
  assert.equal(fs.existsSync(output), false);
  const applied = await exportLisiereSnapshot({ source, output, apply: true, expectedRevision: preview.revision });
  assert.equal(applied.revision, preview.revision); assert.equal(applied.exported, true);
  const archive = readLisiereSnapshot(output), wire = [...archive.androidArguments()];
  assert.equal(archive.manifest.revision, preview.revision);
  assert.equal(wire.length, 2); assert.equal(wire[0].seq, '9007199254740993');
  assert.match(wire[0].argsJson, /"revision":9223372036854775807/);
  assert.match(wire[0].argsJson, /"x":0\.1/);
  assert.equal([...archive.rows('outbox')][0].seq, 9007199254740993n);
  assert.equal(wire[1].status, 'requires-reconciliation'); assert.equal(Object.hasOwn(wire[1], 'argsJson'), false);
  const inventory = inspectLisiereSnapshot(output, { kind: 'operations' });
  assert.equal(inventory.snapshotVersion, 3); assert.equal(inventory.accepted, false);
  assert.equal(inventory.items.length, 2);
  assert.ok(inventory.items.every(item => item.delivery === 'unconfirmed'));
  const audio = inspectLisiereSnapshot(output, { kind: 'recordings' });
  assert.equal(audio.items.length, 1); assert.equal(audio.items[0].context, 'unassigned');
  const manifest = fs.readFileSync(path.join(output, 'manifest.json'));
  await exportLisiereSnapshot({ source, output, apply: true, expectedRevision: preview.revision });
  assert.deepEqual(fs.readFileSync(path.join(output, 'manifest.json')), manifest);
  assert.equal(notebookHash(fs.readFileSync(source)), fixture.sha256);
  await assert.rejects(exportLisiereSnapshot({ source, output, recordings: path.dirname(source) }), /already declares its recordings/);
  // Rewriting a derivative's top-level snapshot hash does not unlink it from
  // the retained native inventory and original outbox cell.
  const retained = path.join(output, 'derived/outbox-args.jsonl');
  const bytes = fs.readFileSync(retained);
  fs.writeFileSync(retained, bytes.toString().replace('"id":"draw-1"', '"id":"other1"'));
  const changed = JSON.parse(manifest), entry = changed.files.find(file => file.path === 'derived/outbox-args.jsonl');
  entry.bytes = fs.statSync(retained).size; entry.sha256 = notebookHash(fs.readFileSync(retained));
  const { revision: ignored, ...unsigned } = changed;
  changed.revision = notebookHash(unsigned);
  for (const name of ['manifest.json', 'export-journal.json']) fs.writeFileSync(path.join(output, name), JSON.stringify(changed) + '\n');
  assert.throws(() => readLisiereSnapshot(output), /native derivative|original identity/);
});

test('installed migrate command accepts a native ZIP with the same preview/apply contract', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-android-zip-cli-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const fixture = JSON.parse(execFileSync('python3', ['-B', script, '--fixture', path.join(base, 'fixture')], options));
  const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url)), output = path.join(base, 'snapshot');
  const run = args => JSON.parse(execFileSync(process.execPath, [cli, 'migrate', '--export-lisiere', fixture.archive, '--output', output, ...args], {
    ...options, cwd: base, env: { ...process.env, HOME: base, CONTEXT_ROOM_HUB_HOME: path.join(base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(base, 'shared') },
  }));
  const preview = run([]);
  assert.equal(preview.ok, true); assert.equal(preview.data.version, 3);
  const applied = run(['--apply', '--revision', preview.data.revision]);
  assert.equal(applied.ok, true); assert.equal(applied.data.revision, preview.data.revision); assert.equal(applied.data.accepted, false);
  assert.equal(fs.existsSync(path.join(base, '.context-room')), false);
});
