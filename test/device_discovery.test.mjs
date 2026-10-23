import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConnectedDeviceService } from '../src/device_server.mjs';
import { clearContextHubRuntime, readContextHubRuntime, writeContextHubRuntime } from '../src/context_hub.mjs';

function service(t, discovery) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-discovery-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const created = createConnectedDeviceService({ stateRoot: path.join(base, 'private-devices'), resolveProject: () => null, discovery });
  t.after(async () => { try { await created.close(); } catch {} });
  return created;
}
function fakeSpawn() {
  const calls = [], children = [];
  const spawn = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { signals: [], kill(signal) { this.signals.push(signal); return true; } });
    calls.push({ command, args, options }); children.push(child); return child;
  };
  return { spawn, calls, children };
}
// 127.0.0.2 is a loopback alias, so a non-loopback bind is simulated through the announce helper's host check only
// where the platform allows it; the announcement itself is always a fake process.
const LAN = process.env.CONTEXT_ROOM_TEST_LAN_HOST;
const lanHost = () => Object.values(os.networkInterfaces()).flat().find(entry => entry.family === 'IPv4' && !entry.internal)?.address;

test('device discovery announces only the public fingerprint and port with dns-sd on macOS', async t => {
  const host = LAN || lanHost();
  if (!host) return t.skip('no LAN address on this machine');
  const fake = fakeSpawn(), device = service(t, { spawn: fake.spawn, platform: 'darwin' });
  const listening = await device.listen({ host, port: 0 });
  assert.equal(fake.calls.length, 1);
  const { command, args, options } = fake.calls[0];
  assert.equal(command, '/usr/bin/dns-sd');
  assert.deepEqual(args, ['-R', `Context Room ${device.fingerprint.slice(0, 12)}`, '_contextroom._tcp', 'local.', String(listening.port), 'version=1', `fingerprint=${device.fingerprint}`]);
  assert.equal(options.stdio, 'ignore');
  const text = args.join(' ');
  assert.ok(!text.includes(device.serverId) && !text.includes(os.homedir()), 'no server id, path or credential in the announcement');
  assert.equal(device.describe().discovery, 'announced');
});

test('device discovery stays off for loopback, non-macOS and --no-device-discovery', async t => {
  const loopback = fakeSpawn(), a = service(t, { spawn: loopback.spawn, platform: 'darwin' });
  await a.listen({ host: '127.0.0.1', port: 0 });
  assert.equal(loopback.calls.length, 0); assert.equal(a.describe().discovery, 'off');
  const host = LAN || lanHost();
  if (!host) return t.skip('no LAN address on this machine');
  const linux = fakeSpawn(), b = service(t, { spawn: linux.spawn, platform: 'linux' });
  await b.listen({ host, port: 0 });
  assert.equal(linux.calls.length, 0); assert.equal(b.describe().discovery, 'unsupported');
  const disabled = fakeSpawn(), c = service(t, { spawn: disabled.spawn, platform: 'darwin', enabled: false });
  await c.listen({ host, port: 0 });
  assert.equal(disabled.calls.length, 0); assert.equal(c.describe().discovery, 'off');
});

test('device discovery stops its dns-sd child when the device service closes', async t => {
  const host = LAN || lanHost();
  if (!host) return t.skip('no LAN address on this machine');
  const fake = fakeSpawn(), device = service(t, { spawn: fake.spawn, platform: 'darwin' });
  await device.listen({ host, port: 0 });
  await device.close();
  assert.deepEqual(fake.children[0].signals, ['SIGTERM']);
});

test('a missing dns-sd keeps the device listener running and reports failed', async t => {
  const host = LAN || lanHost();
  if (!host) return t.skip('no LAN address on this machine');
  const fake = fakeSpawn(), device = service(t, { spawn: fake.spawn, platform: 'darwin' });
  await device.listen({ host, port: 0 });
  fake.children[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.equal(device.describe().discovery, 'failed'); assert.ok(device.server.listening);
  const throwing = service(t, { spawn() { throw new Error('boom'); }, platform: 'darwin' });
  await throwing.listen({ host, port: 0 });
  assert.equal(throwing.describe().discovery, 'failed'); assert.ok(throwing.server.listening);
});

test('hub runtime records the device listener URL and discovery state without secrets', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-discovery-hub-')));
  const previous = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME; else process.env.CONTEXT_ROOM_HUB_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  writeContextHubRuntime({ port: 4999, root: home, url: 'http://127.0.0.1:4999',
    devices: { url: 'https://192.168.1.20:4318', browserUrl: 'https://mac.local:4320', discovery: 'announced', fingerprint: 'a'.repeat(64), token: 'secret' } });
  const runtime = readContextHubRuntime();
  assert.deepEqual(runtime.devices, { url: 'https://192.168.1.20:4318', browserUrl: 'https://mac.local:4320', discovery: 'announced' });
  const stored = fs.readFileSync(path.join(home, 'runtime.json'), 'utf8');
  assert.ok(!stored.includes('secret') && !stored.includes('a'.repeat(64)));
  writeContextHubRuntime({ port: 4999, root: home, url: 'http://127.0.0.1:4999', devices: { url: 'http://192.168.1.20:4318', discovery: 'announced' } });
  assert.equal(readContextHubRuntime().devices, null);
  clearContextHubRuntime();
});
