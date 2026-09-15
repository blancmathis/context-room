import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createContextRoomDeviceService, createMemoryServer, initializeContextRoomProject } from '../src/context_room.mjs';
import { createDeviceOwnerBridge, ownerRequest } from '../src/device_owner.mjs';

async function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-owner-test-'))), root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { previous[key] = process.env[key]; process.env[key] = path.join(base, key); }
  initializeContextRoomProject(root, { title: 'Synthetic owner project', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  const stateRoot = path.join(base, 'devices'), service = createContextRoomDeviceService({ root, stateRoot });
  const room = createMemoryServer({ root, deviceService: service });
  await new Promise(resolve => room.server.listen(0, '127.0.0.1', resolve));
  await service.listen();
  t.after(async () => {
    await service.close();
    await new Promise(resolve => { room.server.closeAllConnections(); room.server.close(resolve); });
    await room.waitForShutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const cert = JSON.parse(fs.readFileSync(path.join(stateRoot, 'identity.json'))).cert;
  function request(token, body, route = '/device/owner/request') {
    return new Promise((resolve, reject) => {
      const req = https.request(service.describe().url + route, { method: 'POST', ca: cert, agent: false,
        checkServerIdentity: (_, peer) => createHash('sha256').update(peer.raw).digest('hex') === service.fingerprint ? undefined : new Error('pin mismatch'),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-context-room-device-protocol': '1' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      }); req.on('error', reject); req.end(JSON.stringify(body));
    });
  }
  const envelope = (target, data, headers = {}) => ({ version: 1, path: target, method: data == null ? 'GET' : 'POST',
    headers: { ...(data == null ? {} : { 'content-type': 'application/json' }), ...headers }, body: data == null ? '' : Buffer.from(JSON.stringify(data)).toString('base64') });
  const decode = response => ({ status: response.body.status, body: Buffer.from(response.body.body || '', 'base64').toString('utf8'), headers: response.body.headers });
  return { root, service, room, request, envelope, decode, origin: `http://127.0.0.1:${room.server.address().port}` };
}

test('complete owner pairing is explicit and drawing credentials never acquire owner routes', async t => {
  const f = await fixture(t);
  const draw = f.service.authority.pair(f.service.createPairing({ projectId: f.room.projectId, paths: ['docs/Sketch.crnb'] }));
  assert.throws(() => f.service.authority.createPairing({ grants: [{ mode: 'owner', serverId: f.service.serverId }] }), { code: 'device_scope_invalid' });
  assert.equal((await f.request(draw.token, f.envelope('/'))).body.code, 'device_owner_required');
  const pair = (body, nonce = '') => fetch(f.origin + '/api/devices/pair-owner', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-context-room-project': f.room.projectId, 'x-context-room-owner-nonce': nonce }, body: JSON.stringify(body) });
  assert.equal((await pair({ mode: 'owner' })).status, 403);
  assert.equal((await pair({}, f.room.ownerMutationNonce)).status, 400);
  const ticket = await (await pair({ mode: 'owner', label: 'Synthetic owner tablet' }, f.room.ownerMutationNonce)).json();
  assert.deepEqual(ticket.grants, [{ mode: 'owner', serverId: f.service.serverId }]);
  const owner = f.service.authority.pair(ticket);
  const page = f.decode(await f.request(owner.token, f.envelope('/')));
  assert.equal(page.status, 200); assert.match(page.body, /context-room-owner-nonce/);
  assert.equal((await f.request(owner.token, f.envelope('/api/devices/pair-owner', { mode: 'owner' }))).body.code, 'device_owner_route');
  f.service.authority.revoke(owner.device.id);
  assert.equal((await f.request(owner.token, f.envelope('/'))).status, 403);
});

test('owner requests retain the real UI nonce, exact project and notebook folder checks', async t => {
  const f = await fixture(t), owner = f.service.authority.pair(f.service.createOwnerPairing());
  const data = { protocolVersion: 1, id: 'owner-notebook', path: 'docs/Owner.crnb' };
  const send = (headers, body = data) => f.request(owner.token, f.envelope('/api/notebooks/open', body, headers)).then(f.decode);
  assert.equal((await send({ 'x-context-room-project': f.room.projectId })).status, 403);
  const headers = { 'x-context-room-project': f.room.projectId, 'x-context-room-owner-nonce': f.room.ownerMutationNonce };
  assert.equal((await send({ ...headers, 'x-context-room-project': '0'.repeat(24) })).status, 409);
  assert.equal((await send(headers, { ...data, path: 'private/Secret.crnb' })).status, 403);
  const result = await send(headers);
  assert.equal(result.status, 200, result.body);
  assert.equal(JSON.parse(result.body).locator.path, 'docs/Owner.crnb');
  assert.equal(fs.existsSync(path.join(f.root, 'docs/Owner.crnb')), false, 'Working ink is not an accepted file');
  const events = await f.request(owner.token, f.envelope('/api/runtime-events?since=0'), '/device/owner/events');
  const stream = f.decode(events);
  assert.equal(stream.status, 200); assert.match(stream.body, /event: ready\ndata: /);
  assert.match(stream.body, /"cursor":\d+/);
  assert.equal((await f.request(owner.token, f.envelope('/api/runtime-events'))).body.code, 'device_owner_stream');
});

test('owner envelopes reject arbitrary origins, cross-site headers and encoded routes', () => {
  for (const target of ['http://127.0.0.1:9/', '//outside.invalid/', '/api/../', '/api/%2e%2e/', '/api/a%2fb', '/api/agent/ui/open', '/api/devices/pair', '/reviews/fixture/api/devices/pair-owner', '/reviews/fixture/api/agent/ui/open', '/api/a#b', '/api/a\\b']) {
    assert.throws(() => ownerRequest({ version: 1, method: 'GET', path: target }), { code: 'device_owner_route' }, target);
  }
  for (const key of ['host', 'origin', 'authorization', 'cookie', 'x-forwarded-host']) assert.throws(() => ownerRequest({ version: 1, method: 'GET', path: '/', headers: { [key]: 'value' } }), { code: 'device_owner_headers' });
  assert.throws(() => ownerRequest({ version: 1, method: 'GET', path: '/', body: 'eA==' }), { code: 'device_owner_body' });
  assert.throws(() => ownerRequest({ version: 1, method: 'POST', path: '/api/test', body: 'not base64' }), { code: 'device_owner_body' });
});

test('a revoked owner cannot receive a delayed response and only one local runtime can attach', async t => {
  let release, started;
  const arrived = new Promise(resolve => { started = resolve; });
  const server = http.createServer((req, res) => { release = () => res.end('private result'); started(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const bridge = createDeviceOwnerBridge(); bridge.attach(server);
  assert.throws(() => bridge.attach(http.createServer()), /already attached/);
  let revoked = false;
  const response = bridge.request({ version: 1, method: 'GET', path: '/api/test' }, { authenticate: () => { if (revoked) throw new Error('revoked'); } });
  await arrived; revoked = true; release();
  await assert.rejects(response, /revoked/);
});

test('pending owner uploads share a bounded body budget until their operations finish', async t => {
  const server = http.createServer(req => req.resume());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const bridge = createDeviceOwnerBridge(); bridge.attach(server);
  const input = { version: 1, method: 'POST', path: '/api/test', body: Buffer.alloc(8 * 1024 * 1024).toString('base64') };
  const requests = Array.from({ length: 8 }, () => bridge.request(input, { authenticate() {} }));
  const finished = Promise.allSettled(requests);
  try {
    await assert.rejects(bridge.request(input, { authenticate() {} }), { code: 'device_owner_busy' });
  } finally { bridge.close(); await finished; }
  // Closing all pending work releases the same budget for another request.
  const next = bridge.request(input, { authenticate() {} }); bridge.close();
  await assert.rejects(next, { code: 'device_owner_unavailable' });
});
