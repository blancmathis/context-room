import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectLocalNetwork } from '../src/local_network_diagnostics.mjs';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'context-room.mjs');
const interfaces = () => ({
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
  utun4: [{ address: '100.64.0.5', family: 'IPv4', internal: false }],
  en1: [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
});
const base = { interfaces, searchPath: '', runtime: null };
const temporary = t => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-network-diagnostic-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const fakeTailscale = (t, output) => {
  const dir = temporary(t), bin = path.join(dir, 'tailscale');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n'); fs.chmodSync(bin, 0o755);
  return { searchPath: dir, calls: [], spawnSync(command, args, options) { this.calls.push({ command, args, options }); return output; } };
};

test('network diagnostics list private LAN addresses without sending packets', async () => {
  const report = await inspectLocalNetwork(base);
  assert.deepEqual(report.lan.addresses, ['10.0.0.7', '192.168.1.20']);
  assert.equal(report.tailscale.state === 'unavailable' || typeof report.tailscale.state === 'string', true);
  assert.equal(report.remoteAccessVerified, false); assert.equal(report.devices.tabletReachabilityVerified, false);
});

test('network diagnostics read Tailscale status only, bound the wait and never activate it', async t => {
  const ok = fakeTailscale(t, { stdout: JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.0.5', 'not-an-ip'] }) });
  const report = await inspectLocalNetwork({ ...base, searchPath: ok.searchPath, spawnSync: (...a) => ok.spawnSync(...a) });
  assert.deepEqual(report.tailscale, { state: 'running', running: true, addresses: ['100.64.0.5'], tabletAccessVerified: false });
  assert.deepEqual(ok.calls.map(call => call.args), [['status', '--json']]);
  assert.equal(ok.calls[0].options.timeout, 5000);
  const bad = fakeTailscale(t, { stdout: 'not json' });
  assert.equal((await inspectLocalNetwork({ ...base, searchPath: bad.searchPath, spawnSync: (...a) => bad.spawnSync(...a) })).tailscale.state, 'unknown');
  const slow = fakeTailscale(t, { error: new Error('ETIMEDOUT'), stdout: null });
  assert.equal((await inspectLocalNetwork({ ...base, searchPath: slow.searchPath, spawnSync: (...a) => slow.spawnSync(...a) })).tailscale.running, false);
});

test('network diagnostics flag a device listener bound to an address the Mac no longer has', async () => {
  const runtime = { pid: process.pid, devices: { url: 'https://192.168.1.99:4318', discovery: 'announced' } };
  const report = await inspectLocalNetwork({ ...base, runtime, connect: () => assert.fail('no connection to an address the Mac lacks') });
  assert.equal(report.devices.state, 'bound-address-missing');
  assert.deepEqual(report.issues.map(issue => issue.code), ['device-address-missing']);
  assert.equal((await inspectLocalNetwork({ ...base, runtime: { pid: 1, devices: runtime.devices }, isAlive: () => false })).devices.state, 'hub-stopped');
  assert.equal((await inspectLocalNetwork({ ...base, runtime: { pid: process.pid, devices: null } })).devices.state, 'not-configured');
  assert.equal((await inspectLocalNetwork({ ...base, runtime: { pid: process.pid, devices: { url: 'https://127.0.0.1:4318', discovery: 'off' } } })).devices.state, 'loopback-only');
});

test('network diagnostics check the local port without claiming tablet reachability', async t => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(), seen = [];
  // The listener answers on loopback; the diagnostic believes it is bound to this Mac's LAN address.
  const connect = request => new Promise(resolve => {
    seen.push(request);
    const socket = net.connect({ host: '127.0.0.1', port: request.port });
    socket.once('connect', () => { socket.destroy(); resolve('listening'); });
    socket.once('error', error => resolve(error.code === 'ECONNREFUSED' ? 'refused' : 'timeout'));
  });
  const run = () => inspectLocalNetwork({ ...base, runtime: { pid: process.pid, devices: { url: `https://192.168.1.20:${port}`, discovery: 'announced' } }, connect });
  let report = await run();
  assert.equal(report.devices.state, 'bound'); assert.equal(report.devices.listener, 'listening'); assert.equal(report.devices.tabletReachabilityVerified, false);
  assert.equal(seen[0].timeout, 1000); assert.equal(seen[0].host, '192.168.1.20');
  await new Promise(resolve => server.close(resolve));
  report = await run();
  assert.equal(report.devices.listener, 'refused');
  assert.deepEqual(report.issues.map(issue => issue.code), ['device-listener-unreachable']);
});

test('doctor JSON includes the network diagnostics and never fails strict mode for them', t => {
  const home = temporary(t), project = temporary(t);
  const env = { ...process.env, CONTEXT_ROOM_HUB_HOME: path.join(home, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(home, 'shared'), CONTEXT_ROOM_ASSISTANT_HOME: path.join(home, 'assistant') };
  const init = spawnSync(process.execPath, [cli, 'init', `--root=${project}`], { encoding: 'utf8', env, timeout: 60000 });
  assert.equal(init.status, 0, init.stderr);
  const result = spawnSync(process.execPath, [cli, 'doctor', `--root=${project}`, '--format=json', '--strict'], { encoding: 'utf8', env, cwd: project, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const network = JSON.parse(result.stdout).data.runtimeDependencies.network;
  assert.equal(network.devices.state, 'hub-stopped'); assert.equal(network.remoteAccessVerified, false);
  const human = spawnSync(process.execPath, [cli, 'doctor', `--root=${project}`], { encoding: 'utf8', env, timeout: 60000 });
  assert.match(human.stdout, /Tablet network: LAN .*tablet listener hub-stopped/);
});
