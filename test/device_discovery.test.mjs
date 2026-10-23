import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { createConnectedDeviceService, ANNOUNCER_SCRIPT } from '../src/device_server.mjs';
import { clearContextHubRuntime, readContextHubRuntime, updateContextHubRuntimeDiscovery, writeContextHubRuntime } from '../src/context_hub.mjs';

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
    const child = Object.assign(new EventEmitter(), { signals: [], stdin: Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } }), kill(signal) { this.signals.push(signal); return true; } });
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
  assert.equal(command, '/bin/sh');
  assert.deepEqual(args.slice(0, 4), ['-c', ANNOUNCER_SCRIPT, 'sh', '/usr/bin/dns-sd']);
  assert.deepEqual(args.slice(3), ['/usr/bin/dns-sd', '-R', `Context Room ${device.fingerprint.slice(0, 12)}`, '_contextroom._tcp', 'local.', String(listening.port), 'version=1', `fingerprint=${device.fingerprint}`]);
  assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore']);
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
  assert.deepEqual(fake.children[0].signals, ['SIGTERM']); assert.equal(fake.children[0].stdin.destroyed, true);
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

test('discovery state follows the life of the dns-sd child and reaches runtime.json', async t => {
  const host = LAN || lanHost();
  if (!host) return t.skip('no LAN address on this machine');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-discovery-life-')));
  const previous = process.env.CONTEXT_ROOM_HUB_HOME; process.env.CONTEXT_ROOM_HUB_HOME = home;
  t.after(() => { clearContextHubRuntime(); if (previous === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME; else process.env.CONTEXT_ROOM_HUB_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const fake = fakeSpawn(), changes = [];
  const device = service(t, { spawn: fake.spawn, platform: 'darwin', onChange: state => { changes.push(state); updateContextHubRuntimeDiscovery(state); } });
  await device.listen({ host, port: 0 });
  writeContextHubRuntime({ port: 4999, root: home, url: 'http://127.0.0.1:4999', devices: { url: 'https://192.168.1.20:4318', discovery: device.describe().discovery } });
  assert.equal(readContextHubRuntime().devices.discovery, 'announced');
  fake.children[0].emit('exit', 1, null); // dns-sd died after the start
  assert.equal(device.describe().discovery, 'failed'); assert.deepEqual(changes, ['failed']);
  assert.equal(fake.children[0].stdin.destroyed, true);
  assert.equal(readContextHubRuntime().devices.discovery, 'failed');
  assert.equal(updateContextHubRuntimeDiscovery('failed', process.pid + 1), false, 'another process runtime is never changed');
  assert.equal(updateContextHubRuntimeDiscovery('bogus'), false);
});

test('the announcer shell stops its child when the Hub is killed, never by name', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-announcer-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'child.pid');
  // The fake "Hub" starts the real announcer shell around a long sleep, records the sleep pid, then waits.
  const hub = `const {spawn}=require('node:child_process');const c=spawn('/bin/sh',['-c',${JSON.stringify(ANNOUNCER_SCRIPT)},'sh','/bin/sh','-c','echo $$ > '+${JSON.stringify(pidFile)}+'; exec sleep 300'],{stdio:['pipe','ignore','ignore']});setInterval(()=>{},1000);`;
  const parent = realSpawn(process.execPath, ['-e', hub], { stdio: 'ignore' });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} try { parent.kill('SIGKILL'); } catch {} });
  assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()), 'announced child started');
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(childPid));
  parent.kill('SIGKILL');
  assert.ok(await waitFor(() => !alive(childPid)), 'the child stopped after the Hub was killed');
});
