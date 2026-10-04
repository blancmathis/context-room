import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attestLocation, observeLocation, acceptsRootIdentity, rootIdentityAliases } from '../src/location_attestation.mjs';
import { canonicalNotebookRoot } from '../src/notebook_io.mjs';
import { readFilesystemIdentity } from '../src/filesystem_identity.mjs';
import { createDeviceAuthority } from '../src/device_authority.mjs';
import { ensureAuthorityKey } from '../src/review_authority.mjs';

const worker = fileURLToPath(new URL('./fixtures/location_attestation.mjs', import.meta.url));
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-location-')));
  const root = path.join(base, 'project'), home = path.join(base, 'authority');
  for (const folder of [root, path.join(base, 'conversations'), path.join(base, 'devices')]) fs.mkdirSync(folder, { mode: 0o700 });
  const options = { authorityHome: home };
  const env = { ...process.env, CONTEXT_ROOM_REVIEW_AUTHORITY_HOME: home,
    CONTEXT_ROOM_HUB_HOME: path.join(base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(base, 'shared') };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, home, options, env,
    run: (action, change = {}) => execFileSync(process.execPath, [worker, action, base, JSON.stringify(change)],
      { env, encoding: 'utf8', timeout: 60_000, stdio: 'pipe' }) };
}
function tree(directory) {
  const files = {};
  if (!fs.existsSync(directory)) return files;
  const visit = rel => {
    for (const entry of fs.readdirSync(path.join(directory, rel), { withFileTypes: true })) {
      const name = path.join(rel, entry.name);
      if (entry.isDirectory()) visit(name);
      else files[name] = fs.readFileSync(path.join(directory, name));
    }
  };
  visit(''); return files;
}
function recordPath(home) { return fs.readdirSync(home).find(name => /^location-.*\.json$/.test(name)); }

test('strict comparison and observation never enroll a missing or unreadable location', t => {
  const f = fixture(t), identity = canonicalNotebookRoot(f.root);
  assert.equal(acceptsRootIdentity(f.root, identity, f.options), 'same');
  assert.equal(acceptsRootIdentity(f.root, '0:1', f.options), 'different');
  for (const stored of [null, '', '01:2', '0:0', {}, `${identity}:extra`]) assert.equal(acceptsRootIdentity(f.root, stored, f.options), 'unverified');
  assert.deepEqual(observeLocation(f.root, f.options), { status: 'unverified', added: false });
  assert.equal(fs.existsSync(f.home), false);
  const stat = fs.lstatSync;
  fs.lstatSync = (...args) => {
    const value = stat(...args);
    if (args[0] === f.root && args[1]?.bigint) value.birthtimeNs = 0n;
    return value;
  };
  try {
    assert.equal(acceptsRootIdentity(f.root, identity, f.options), 'same');
    assert.throws(() => attestLocation(f.root, f.options), /cannot be verified/);
  } finally { fs.lstatSync = stat; }
  assert.equal(fs.existsSync(f.home), false);
});

test('explicit enrollment merges only exact-path signed aliases and keeps private bytes', t => {
  const f = fixture(t), identity = canonicalNotebookRoot(f.root), legacy = `0:${identity.split(':')[1]}`;
  const first = attestLocation(f.root, { ...f.options, legacy });
  assert.deepEqual(first.durable, readFilesystemIdentity(f.root).identity);
  assert.equal(first.path, f.root); assert.equal(first.v, 1);
  assert.equal(acceptsRootIdentity(f.root, legacy, f.options), 'confirmed');
  assert.deepEqual(first.aliases, { observed: [identity], confirmed: [legacy] });
  const before = tree(f.home);
  assert.deepEqual(attestLocation(f.root, f.options), first);
  assert.deepEqual(observeLocation(f.root, f.options), { status: 'same', added: false });
  assert.deepEqual(tree(f.home), before);
  for (const name of Object.keys(before)) assert.equal(fs.statSync(path.join(f.home, name)).mode & 0o077, 0);
  assert.equal(fs.statSync(f.home).mode & 0o077, 0);
  const other = path.join(f.base, 'other'); fs.mkdirSync(other);
  assert.equal(acceptsRootIdentity(other, legacy, f.options), 'different');
  assert.throws(() => attestLocation(f.root, { authorityHome: path.join(f.root, 'private') }), /outside the project/);
});

test('edited, unsigned, missing-key, hardlinked and symbolic attestations provide no aliases', t => {
  const f = fixture(t), record = attestLocation(f.root, { ...f.options, legacy: '0:1' });
  const file = path.join(f.home, recordPath(f.home)), bytes = fs.readFileSync(file), key = path.join(f.home, 'authority.key');
  for (const changed of [{ ...record, aliases: { ...record.aliases, confirmed: [...record.aliases.confirmed, '0:2'] } }, { ...record, signature: '' }, { ...record, path: f.root + '/other' }]) {
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.equal(acceptsRootIdentity(f.root, '0:1', f.options), 'different');
    const before = tree(f.home); assert.deepEqual(observeLocation(f.root, f.options), { status: 'unverified', added: false });
    assert.deepEqual(tree(f.home), before);
  }
  fs.writeFileSync(file, bytes);
  fs.renameSync(key, key + '.old');
  assert.equal(acceptsRootIdentity(f.root, '0:1', f.options), 'different');
  fs.renameSync(key + '.old', key);
  fs.linkSync(file, file + '.link'); assert.equal(acceptsRootIdentity(f.root, '0:1', f.options), 'different'); fs.unlinkSync(file + '.link');
  fs.renameSync(file, file + '.old'); fs.symlinkSync(file + '.old', file);
  assert.equal(acceptsRootIdentity(f.root, '0:1', f.options), 'different');
});

test('new processes reopen notebook history, conversations, submitted proposals and grants only with attested continuity', t => {
  const f = fixture(t); f.run('create');
  const project = tree(f.root), conversations = tree(path.join(f.base, 'conversations')), devices = tree(path.join(f.base, 'devices'));
  f.run('blocked', { dev: 2 }); assert.equal(fs.existsSync(f.home), false);
  f.run('attest'); const authority = tree(f.home);
  f.run('read', { dev: 2 });
  assert.deepEqual(tree(f.home), authority); // No reader observes/enrolls as a side effect.
  assert.deepEqual(tree(f.root), project); assert.deepEqual(tree(path.join(f.base, 'conversations')), conversations);
  assert.deepEqual(tree(path.join(f.base, 'devices')), devices);
  f.run('observe', { dev: 2 });
  f.run('read', { dev: 4 }); // A further mount is accepted but not recorded by the reader.
  assert.deepEqual(tree(f.root), project); assert.deepEqual(tree(path.join(f.base, 'conversations')), conversations);
  assert.deepEqual(tree(path.join(f.base, 'devices')), devices);
  const record = path.join(f.home, fs.readdirSync(f.home).find(name => name.startsWith('location-')
    && name.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(f.home, name))).path === f.root));
  const bytes = fs.readFileSync(record), edited = JSON.parse(bytes); edited.aliases.confirmed.push('0:1');
  fs.writeFileSync(record, JSON.stringify(edited)); f.run('blocked', { dev: 2 }); fs.writeFileSync(record, bytes);
  f.run('recover-workflow', { dev: 2 });
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.context-room/workflow-state.json')), project['.context-room/workflow-state.json']);
});

test('inode, birthtime and unavailable durable identity block old aliases in another process', t => {
  const f = fixture(t); f.run('create'); f.run('attest'); const before = tree(f.home);
  for (const change of [{ dev: 2, ino: 1 }, { dev: 2, birth: 1 }, { dev: 2, missingBirth: true }]) f.run('blocked', change);
  assert.deepEqual(tree(f.home), before);
});

test('new data in a replacement root remains readable under its strict identity', t => {
  const f = fixture(t); f.run('create'); f.run('attest');
  fs.renameSync(f.root, f.root + '.old'); fs.mkdirSync(f.root, { mode: 0o700 });
  const authority = tree(f.home);
  f.run('create');
  const project = tree(f.root), conversations = tree(path.join(f.base, 'conversations')), devices = tree(path.join(f.base, 'devices'));
  f.run('read');
  assert.deepEqual(tree(f.root), project); assert.deepEqual(tree(path.join(f.base, 'conversations')), conversations);
  assert.deepEqual(tree(path.join(f.base, 'devices')), devices); assert.deepEqual(tree(f.home), authority);
});

test('replacing an enrollment is explicit and abandons both kinds of old aliases', t => {
  const f = fixture(t), originalIdentity = canonicalNotebookRoot(f.root);
  attestLocation(f.root, { ...f.options, legacy: '0:1' });
  const before = tree(f.home);
  fs.renameSync(f.root, f.root + '.old'); fs.mkdirSync(f.root);
  assert.throws(() => attestLocation(f.root, f.options), /was replaced/); assert.deepEqual(tree(f.home), before);
  const identity = canonicalNotebookRoot(f.root), record = attestLocation(f.root, { ...f.options, replace: true, legacy: '0:2' });
  assert.deepEqual(record.durable, readFilesystemIdentity(f.root).identity);
  assert.deepEqual(record.aliases, { observed: [identity], confirmed: ['0:2'] });
  assert.equal(acceptsRootIdentity(f.root, originalIdentity, f.options), 'different');
  assert.equal(acceptsRootIdentity(f.root, '0:1', f.options), 'different');
  assert.equal(acceptsRootIdentity(f.root, identity, f.options), 'same');
  assert.equal(acceptsRootIdentity(f.root, '0:2', f.options), 'confirmed');
});

test('confirmed history reopens all data readers but does not reactivate drawing grants', t => {
  const f = fixture(t); f.run('create');
  f.run('confirm', { dev: 2 });
  const project = tree(f.root), conversations = tree(path.join(f.base, 'conversations')), devices = tree(path.join(f.base, 'devices')), authority = tree(f.home);
  f.run('read-confirmed', { dev: 2 });
  assert.deepEqual(tree(f.root), project); assert.deepEqual(tree(path.join(f.base, 'conversations')), conversations);
  assert.deepEqual(tree(path.join(f.base, 'devices')), devices); assert.deepEqual(tree(f.home), authority);
  f.run('recover-workflow', { dev: 2 });
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.context-room/workflow-state.json')), project['.context-room/workflow-state.json']);
});

test('enrollment reuses the review authority key without creating or replacing another key', t => {
  const f = fixture(t), paths = { base: f.home, key: path.join(f.home, 'authority.key') };
  const key = ensureAuthorityKey(paths);
  assert.equal(key.length, 32);
  attestLocation(f.root, f.options);
  assert.deepEqual(fs.readFileSync(paths.key), key);
  assert.deepEqual(ensureAuthorityKey(paths), key);
  assert.equal(fs.readdirSync(f.home).filter(name => name.endsWith('.key')).length, 1);
});

test('copies, replacement roots, other paths and symlinks do not inherit enrolled aliases', t => {
  const f = fixture(t), identity = canonicalNotebookRoot(f.root);
  const record = attestLocation(f.root, { ...f.options, legacy: '0:1' });
  const copy = path.join(f.base, 'copy'); fs.cpSync(f.root, copy, { recursive: true });
  assert.equal(acceptsRootIdentity(copy, identity, f.options), 'different');
  fs.renameSync(f.root, f.root + '.old'); fs.mkdirSync(f.root);
  assert.equal(acceptsRootIdentity(f.root, '0:1', f.options), 'different');
  assert.equal(acceptsRootIdentity(f.root, canonicalNotebookRoot(f.root), f.options), 'same');
  assert.deepEqual(rootIdentityAliases(f.root, f.options), [canonicalNotebookRoot(f.root)]);
  assert.deepEqual(observeLocation(f.root, f.options), { status: 'different', added: false });
  assert.throws(() => attestLocation(f.root, f.options), /was replaced/);
  fs.rmdirSync(f.root); fs.symlinkSync(f.root + '.old', f.root);
  assert.equal(acceptsRootIdentity(f.root, identity, f.options), 'unverified');
  assert.equal(record.path, f.root);
});

test('a strict drawing grant wins over a contradictory durable attestation', t => {
  const f = fixture(t), variable = 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME', previousHome = process.env[variable];
  process.env[variable] = f.home;
  t.after(() => { if (previousHome === undefined) delete process.env[variable]; else process.env[variable] = previousHome; });
  attestLocation(f.root, f.options);
  const authority = createDeviceAuthority({ stateRoot: path.join(f.base, 'devices'), serverId: 'fixture-server' });
  const ticket = authority.createPairing({ label: 'Fixture', grants: [{ mode: 'draw', projectId: 'a'.repeat(24),
    root: f.root, rootIdentity: canonicalNotebookRoot(f.root), paths: ['docs/Scene.crnb'] }] });
  const paired = authority.pair({ ...ticket, protocolVersion: 1 });
  const stat = fs.lstatSync;
  fs.lstatSync = (...args) => { const value = stat(...args); if (args[0] === f.root && args[1]?.bigint) value.birthtimeNs += 1n; return value; };
  try { assert.equal(authority.authenticate(paired.token).grants[0].rootIdentity, canonicalNotebookRoot(f.root)); }
  finally { fs.lstatSync = stat; }
});

test('concurrent processes merge attestation aliases under a filesystem lock', async t => {
  const f = fixture(t), url = new URL('../src/location_attestation.mjs', import.meta.url).href;
  attestLocation(f.root, f.options);
  const run = legacy => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {attestLocation} from ${JSON.stringify(url)}; attestLocation(process.argv[1], {legacy:process.argv[2]});`, f.root, legacy],
    { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `child exit ${code}`)));
  });
  await Promise.all([run('0:1'), run('0:2')]);
  assert.equal(acceptsRootIdentity(f.root, '0:1', f.options), 'confirmed');
  assert.equal(acceptsRootIdentity(f.root, '0:2', f.options), 'confirmed');
});

test('a root exchange during atomic publication fails before signing it into the location', t => {
  const f = fixture(t), rename = fs.renameSync;
  // Exchange the root after the temporary bytes are durable, before the final validation.
  const sync = fs.fsyncSync; let exchanged = false;
  fs.fsyncSync = fd => {
    sync(fd);
    if (!exchanged && fs.existsSync(f.home) && fs.readdirSync(f.home).some(name => name.startsWith('location-') && name.endsWith('.tmp'))) {
      exchanged = true; rename(f.root, f.root + '.old'); fs.mkdirSync(f.root);
    }
  };
  try { assert.throws(() => attestLocation(f.root, f.options), /changed before attestation/); } finally { fs.fsyncSync = sync; }
  assert.equal(exchanged, true);
  assert.equal(fs.readdirSync(f.home).some(name => /^location-.*\.json$/.test(name)), false);
});


test('caller evidence rejects a replacement before creating authority state', t => {
  const f = fixture(t), expected = { legacy: canonicalNotebookRoot(f.root), durable: readFilesystemIdentity(f.root).identity };
  fs.renameSync(f.root, f.root + '.old'); fs.mkdirSync(f.root);
  assert.throws(() => attestLocation(f.root, { ...f.options, expected, replace: true, legacy: expected.legacy }),
    { code: 'location_attestation_conflict' });
  assert.equal(fs.existsSync(f.home), false);
});
