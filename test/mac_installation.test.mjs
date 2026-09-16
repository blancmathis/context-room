import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareMacInstallation, verifyMacInstallation, macLaunchAgent } from '../src/mac_installation.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-mac-install-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), output = path.join(base, 'private-kit');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true }); fs.mkdirSync(path.join(source, 'bin'));
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'context-room', version: '0.0.0-synthetic', files: ['bin/', 'src/'] }));
  fs.writeFileSync(path.join(source, 'package-lock.json'), '{"name":"context-room","lockfileVersion":3}\n');
  fs.writeFileSync(path.join(source, 'bin/context-room.mjs'), 'console.log("Synthetic installation fixture; not a production runtime")\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'src/mac_installation.mjs'), 'export const synthetic = true;\n');
  return { base, source, output, options: { output, nodePath: '/opt/context-room-node/bin/node' } };
}

test('Mac installation preparation is read-only until exact apply, complete and idempotent without dependencies, services or user-state copies', t => {
  const f = fixture(t), plan = prepareMacInstallation(f.source, f.options);
  assert.equal(fs.existsSync(f.output), false); assert.equal(plan.prepared, false);
  assert.throws(() => prepareMacInstallation(f.source, { ...f.options, apply: true, expectedRevision: '0'.repeat(64) }), /changed after/);
  const result = prepareMacInstallation(f.source, { ...f.options, apply: true, expectedRevision: plan.revision });
  assert.equal(result.prepared, true); assert.equal(result.activated, false); assert.equal(result.dependenciesIncluded, false);
  assert.equal(verifyMacInstallation(f.output, plan.revision).verified, true);
  assert.equal(fs.statSync(path.join(f.output, 'runtime/bin/context-room.mjs')).mode & 0o777, 0o755);
  const manifest = fs.readFileSync(path.join(f.output, 'manifest.json'));
  assert.equal(prepareMacInstallation(f.source, { ...f.options, apply: true, expectedRevision: plan.revision }).replayed, true);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'manifest.json')), manifest);
  fs.unlinkSync(path.join(f.output, 'manifest.json')); fs.unlinkSync(path.join(f.output, 'runtime/src/mac_installation.mjs'));
  assert.throws(() => verifyMacInstallation(f.output, plan.revision), /incomplete/);
  prepareMacInstallation(f.source, { ...f.options, apply: true, expectedRevision: plan.revision });
  fs.writeFileSync(path.join(f.output, 'runtime/src/mac_installation.mjs'), 'Later local edits');
  assert.throws(() => prepareMacInstallation(f.source, { ...f.options, apply: true, expectedRevision: plan.revision }), /different contents/);
  assert.equal(fs.readFileSync(path.join(f.output, 'runtime/src/mac_installation.mjs'), 'utf8'), 'Later local edits');
});

test('Mac kit rejects original changes, unsafe inputs, occupied outputs and unlisted runtime entries', t => {
  const f = fixture(t), plan = prepareMacInstallation(f.source, f.options);
  fs.appendFileSync(path.join(f.source, 'package-lock.json'), ' ');
  assert.throws(() => prepareMacInstallation(f.source, { ...f.options, apply: true, expectedRevision: plan.revision }), /changed after/);
  fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output, 'human.txt'), 'Keep this file');
  const next = prepareMacInstallation(f.source, f.options);
  assert.throws(() => prepareMacInstallation(f.source, { ...f.options, apply: true, expectedRevision: next.revision }), /private|occupied/);
  fs.symlinkSync(path.join(f.source, 'package-lock.json'), path.join(f.source, 'src/linked.mjs'));
  assert.throws(() => prepareMacInstallation(f.source, f.options), /linked/);
  fs.unlinkSync(path.join(f.source, 'src/linked.mjs')); fs.writeFileSync(path.join(f.source, 'src/credential.key'), 'Synthetic—not a key');
  assert.throws(() => prepareMacInstallation(f.source, f.options), /credential/);
});

test('rendered LaunchAgent uses exact arguments, no shell, no registration or paid-provider fallback and preserves existing product stores', t => {
  const f = fixture(t), home = path.join(f.base, 'synthetic home');
  const xml = macLaunchAgent({ runtime: '/opt/Context Room & local', home, nodePath: '/opt/Node & tools/node', port: 4317 });
  const parsed = JSON.parse(execFileSync('python3', ['-B', '-c', 'import plistlib,json,sys;print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'], { input: xml, encoding: 'utf8' }));
  assert.deepEqual(parsed.ProgramArguments, ['/opt/Node & tools/node', '/opt/Context Room & local/bin/context-room.mjs', 'hub', '--no-local', '--port', '4317']);
  assert.equal(parsed.Label, 'app.contextroom.local'); assert.equal(parsed.KeepAlive.SuccessfulExit, false);
  assert.deepEqual(Object.keys(parsed.EnvironmentVariables), ['PATH']);
  assert.equal(parsed.EnvironmentVariables.PATH.startsWith('/opt/Node & tools:'), true);
  assert.equal(Object.keys(parsed.EnvironmentVariables).some(key => key.endsWith('_HOME')), false);
  assert.equal(fs.existsSync(home), false); assert.doesNotMatch(xml, /lisiere|shell|whisper|device-host|sudo/);
});

// The exported library receives canonical roots, but a directory file: URL has a
// trailing slash. Exercise the actual installed script's default, not a fixture
// that bypasses its URL-to-path conversion. Explicit user roots remain strict.
test('installation CLI canonicalizes its own default source and prepares the actual package without a legacy runtime', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-mac-install-cli-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const output = path.join(base, 'kit');
  const script = fileURLToPath(new URL('../scripts/prepare-mac-install.mjs', import.meta.url));
  const args = [script, '--output', output, '--node', '/opt/context-room-node/bin/node'];
  const options = { cwd: base, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: 'pipe' };
  const invoke = extra => JSON.parse(execFileSync(process.execPath, [...args, ...extra], options));
  const plan = invoke([]);
  assert.equal(plan.prepared, false); assert.equal(fs.existsSync(output), false);
  assert.match(plan.revision, /^[0-9a-f]{64}$/); assert.ok(plan.files > 100);
  const applied = invoke(['--apply', '--revision', plan.revision]);
  assert.equal(applied.prepared, true); assert.equal(applied.activated, false);
  const verified = invoke(['--verify', '--revision', plan.revision]);
  assert.equal(verified.verified, true); assert.equal(verified.dependenciesIncluded, false);
  assert.equal(fs.existsSync(path.join(output, 'runtime/node_modules')), false);
  assert.equal(invoke(['--apply', '--revision', plan.revision]).replayed, true);
  assert.deepEqual(fs.readFileSync(path.join(output, 'runtime/scripts/prepare-mac-install.mjs')), fs.readFileSync(script));
  // Normalization belongs to the derived default; it must not weaken root checks.
  assert.throws(() => invoke(['--source', fileURLToPath(new URL('..', import.meta.url))]), /exact absolute filesystem location/);
});
