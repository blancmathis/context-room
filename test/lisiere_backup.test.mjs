import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/lisiere-backup.py', import.meta.url));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fakeHome(base) {
  const home = path.join(base, 'home');
  const data = path.join(home, '.local/share/lisiere');
  const workspace = path.join(data, 'workspace');
  fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(data, 'signing'), { recursive: true });
  fs.mkdirSync(path.join(data, 'models'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Documents/Lisière/Carnets/Un.lisiere'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Documents/Lisière/Carnets/Deux.lisiere'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Library/LaunchAgents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.writeFileSync(path.join(data, 'signing/development.keystore'), crypto.randomBytes(256));
  fs.writeFileSync(path.join(data, 'models/large.bin'), 'model weights');
  fs.writeFileSync(path.join(workspace, 'service.log'), 'log\n');
  fs.writeFileSync(path.join(workspace, 'assets/a.png'), 'png');
  fs.writeFileSync(path.join(home, 'Documents/Lisière/README.md'), '# Lisière\n');
  fs.writeFileSync(path.join(home, 'Documents/Lisière/Carnets/Un.lisiere/page.json'), '{}');
  for (const label of ['fr.lisiere.companion', 'fr.lisiere.updates']) fs.writeFileSync(path.join(home, `Library/LaunchAgents/${label}.plist`), `<plist>${label}</plist>`);
  const target = path.join(base, 'lisiere-cli');
  fs.writeFileSync(target, '#!/bin/sh\n');
  fs.symlinkSync(target, path.join(home, '.local/bin/lisiere'));
  // WAL database closed cleanly: no -wal/-shm left, which defeats mode=ro.
  execFileSync('python3', ['-B', '-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('pragma journal_mode=wal')
for t in ('boards','objects','conversations','messages','projects','proposals','drafts','recordings'): c.execute('create table '+t+'(x)')
c.executemany('insert into boards values(?)', [(i,) for i in range(3)]); c.execute("insert into messages values('m')")
c.commit(); c.execute('pragma wal_checkpoint(truncate)'); c.close()`, path.join(workspace, 'workspace.sqlite')]);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(path.join(workspace, `workspace.sqlite${suffix}`), { force: true });
  return { home, data, workspace };
}

const run = (home, args) => spawnSync('python3', ['-B', script, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });

test('lisiere backup refuses an existing destination and verifies counts, archive and keystore checksum', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-lisiere-backup-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { home, data, workspace } = fakeHome(base);
  const before = fs.readdirSync(workspace).sort();

  const existing = path.join(base, 'existing');
  fs.mkdirSync(existing);
  const refused = run(home, ['--output', existing]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
  assert.deepEqual(fs.readdirSync(existing), []);
  assert.match(run(home, ['--output', path.join(data, 'inside')]).stderr, /outside the Lisière data/);

  const output = path.join(base, 'backup');
  const done = run(home, ['--output', output]);
  assert.equal(done.status, 0, done.stderr);
  const result = JSON.parse(done.stdout);
  assert.equal(result.verified, true);
  assert.deepEqual(result.counts.tables, { boards: 3, conversations: 0, drafts: 0, messages: 1, objects: 0, projects: 0, proposals: 0, recordings: 0 });
  assert.deepEqual(result.counts.missingTables, ['devices']);
  assert.equal(result.counts.carnets, 2);
  assert.deepEqual(result.onlineCopyCounts, result.counts.tables);
  assert.equal(result.keystoreSha256, sha(path.join(data, 'signing/development.keystore')));
  assert.equal(sha(path.join(output, 'development.keystore')), result.keystoreSha256);
  assert.equal(result.modelsExcluded, 1);
  assert.deepEqual(result.plists, ['fr.lisiere.companion', 'fr.lisiere.updates']);
  assert.ok(result.volatile.includes('.local/share/lisiere/workspace/service.log'));
  assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(workspace).sort(), before, 'the source workspace keeps no -wal/-shm residue');

  const listed = execFileSync('tar', ['-tzf', path.join(output, 'lisiere-data.tgz')], { encoding: 'utf8' }).normalize('NFC').trim().split('\n');
  assert.equal(listed.length, result.archive.members);
  assert.ok(listed.includes('.local/share/lisiere/signing/development.keystore'));
  assert.ok(listed.includes('.local/bin/lisiere'));
  assert.ok(listed.includes('link-target/lisiere-cli'));
  assert.ok(listed.includes('Library/LaunchAgents/fr.lisiere.updates.plist'));
  assert.ok(listed.some(name => name.startsWith('Documents/Lisière/Carnets/Un.lisiere')));
  assert.ok(!listed.some(name => name.includes('models/large.bin')));
  const sums = fs.readFileSync(path.join(output, 'SHA256SUMS'), 'utf8');
  assert.match(sums, new RegExp(`^${result.keystoreSha256}  \\.local/share/lisiere/signing/development\\.keystore$`, 'm'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'models.json'), 'utf8')).map(entry => entry.path), ['.local/share/lisiere/models/large.bin']);

  const retained = path.join(data, 'workspace.context-room-retired-0123456789abcdef');
  fs.renameSync(workspace, retained);
  const after = run(home, ['--output', path.join(base, 'backup-retained'), '--source-retained', retained]);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).retained, true);
  assert.deepEqual(JSON.parse(after.stdout).counts.tables, result.counts.tables);
  assert.match(run(home, ['--output', path.join(base, 'bad'), '--source-retained', path.join(base, 'elsewhere')]).stderr, /retained workspace inside/);
});
