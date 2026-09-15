import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';
import { readLisiereSnapshot } from '../src/lisiere_archive.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-legacy-recordings-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'databases'), recordings = path.join(base, 'dictation'), output = path.join(base, 'snapshot');
  fs.mkdirSync(source); fs.mkdirSync(recordings);
  execFileSync('python3', ['-B', '-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,operation TEXT,args TEXT,error TEXT);')
 db.execute('INSERT INTO cache VALUES(?,?)',('native-voice-draft:original:unresolved','{"queued":{"text":"Original unsent phrase"}}'))`, path.join(source, 'workspace.sqlite')], { stdio: 'pipe' });
  // Synthetic PCM spans multiple reader chunks; no microphone is opened.
  const pcm = Buffer.alloc(160000); for (let at = 0; at < pcm.length; at += 2) pcm.writeInt16LE(at % 32000 - 16000, at);
  const name = 'b'.repeat(64) + '.pcm', file = path.join(recordings, name); fs.writeFileSync(file, pcm);
  fs.writeFileSync(path.join(base, 'authentication-preferences.xml'), 'Synthetic preferences outside the selected recovery directories');
  return { base, source, recordings, output, file, name, pcm, options: { source, recordings, output } };
}

test('version-2 Android snapshot preserves exact bounded original recordings through preview, apply, read and repeat', async t => {
  const f = fixture(t), database = fs.readFileSync(path.join(f.source, 'workspace.sqlite'));
  const plan = await exportLisiereSnapshot(f.options); assert.equal(plan.version, 2); assert.equal(fs.existsSync(f.output), false);
  assert.deepEqual(plan.recordings.paths, ['recordings/' + f.name]);
  assert.deepEqual([plan.recordings.encoding, plan.recordings.sampleRate, plan.recordings.channels], ['pcm-s16le', 16000, 1]);
  assert.equal(plan.files.length, 3);
  await exportLisiereSnapshot({ ...f.options, apply: true, expectedRevision: plan.revision });
  const archive = readLisiereSnapshot(f.output); assert.deepEqual(archive.recording(f.name), f.pcm);
  assert.match([...archive.rows('cache')][0].value, /Original unsent phrase/);
  assert.equal(fs.statSync(path.join(f.output, 'recordings', f.name)).mode & 0o777, 0o600);
  assert.equal((await exportLisiereSnapshot({ ...f.options, apply: true, expectedRevision: plan.revision })).revision, plan.revision);
  assert.deepEqual(fs.readFileSync(f.file), f.pcm); assert.deepEqual(fs.readFileSync(path.join(f.source, 'workspace.sqlite')), database);
  assert.throws(() => archive.recording('../outside.pcm'), /exact original recording/);
  const retained = path.join(f.output, 'recordings', f.name); fs.writeFileSync(retained, Buffer.alloc(f.pcm.length));
  assert.throws(() => archive.recording(f.name), /snapshot hash/);
  await assert.rejects(exportLisiereSnapshot({ ...f.options, apply: true, expectedRevision: plan.revision }), /contains different data/);
});

test('changed recordings, unsafe files and occupied source locations remain recoverable and are never overwritten', async t => {
  const f = fixture(t), plan = await exportLisiereSnapshot(f.options);
  fs.writeFileSync(f.file, Buffer.alloc(3200));
  await assert.rejects(exportLisiereSnapshot({ ...f.options, apply: true, expectedRevision: plan.revision }), /changed after/);
  assert.equal(fs.existsSync(f.output), false); assert.deepEqual(fs.readFileSync(f.file), Buffer.alloc(3200));
  for (const content of [Buffer.alloc(3), Buffer.alloc(16000 * 2 * 120 + 2)]) {
    fs.writeFileSync(f.file, content); await assert.rejects(exportLisiereSnapshot(f.options), /incomplete|two-minute/);
  }
  fs.unlinkSync(f.file); fs.symlinkSync(path.join(f.base, 'authentication-preferences.xml'), f.file);
  await assert.rejects(exportLisiereSnapshot(f.options), /symbolic/);
  fs.unlinkSync(f.file); fs.writeFileSync(f.file, f.pcm);
  const current = await exportLisiereSnapshot(f.options);
  await assert.rejects(exportLisiereSnapshot({ ...f.options, output: path.join(f.recordings, 'nested'), apply: true, expectedRevision: current.revision }), /outside the original/);
  fs.writeFileSync(path.join(f.recordings, 'unknown.wav'), 'Unknown original format');
  await assert.rejects(exportLisiereSnapshot(f.options), /unknown legacy recording/);
});

test('installed export CLI includes an explicitly selected recording directory without account preferences', t => {
  const f = fixture(t), cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
  const args = [cli, 'migrate', '--export-lisiere', f.source, '--recordings', f.recordings, '--output', f.output];
  const options = { cwd: f.base, encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: f.base,
    CONTEXT_ROOM_HUB_HOME: path.join(f.base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(f.base, 'shared') } };
  const plan = JSON.parse(execFileSync(process.execPath, args, options)); assert.equal(plan.ok, true); assert.equal(plan.data.version, 2);
  const applied = JSON.parse(execFileSync(process.execPath, [...args, '--apply', '--revision', plan.data.revision], options));
  assert.equal(applied.ok, true); assert.equal(applied.data.exported, true);
  assert.deepEqual(readLisiereSnapshot(f.output).recording(f.name), f.pcm);
});

test('a recording changed during its bounded read cannot produce a completed recovery snapshot', t => {
  const f = fixture(t), helper = fileURLToPath(new URL('../src/lisiere_snapshot.py', import.meta.url));
  const output = execFileSync('python3', ['-B', '-c', `import importlib.util,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('snapshot_contract',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
recording=Path(sys.argv[4])
inode=recording.stat().st_ino
original=os.fstat
calls=0
def changed(fd):
 global calls
 stat=original(fd)
 if stat.st_ino==inode:
  calls+=1
  if calls==2:
   with recording.open('r+b') as file:
    file.write(b'XX')
    file.flush()
    os.fsync(file.fileno())
 return original(fd)
os.fstat=changed
try:
 module.snapshot(Path(sys.argv[2]),recordings=Path(sys.argv[3]))
 raise AssertionError('Changed recording was accepted')
except ValueError as error:
 assert 'changed during the snapshot' in str(error),str(error)
 assert calls>=2
 print('interrupted recording refused')`, helper, f.source, f.recordings, f.file], { encoding: 'utf8', timeout: 10000 });
  assert.match(output, /interrupted recording refused/); assert.equal(fs.existsSync(f.output), false);
});
