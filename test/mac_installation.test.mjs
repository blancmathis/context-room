import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
