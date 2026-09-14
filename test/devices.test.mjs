import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createConnectedDeviceService } from '../src/device_server.mjs';
import { createDeviceAuthority, ensureDeviceIdentity } from '../src/device_authority.mjs';
import { canonicalNotebookRoot } from '../src/notebook_io.mjs';
import { readNotebook, mutateNotebook, openNotebook, NOTEBOOK_STORE } from '../src/notebooks.mjs';
import { createContextRoomDeviceService, createMemoryServer, initializeContextRoomProject } from '../src/context_room.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-device-test-')));
  const root = path.join(base, 'project'), stateRoot = path.join(base, 'private-devices');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const projectId = createHash('sha256').update(root).digest('hex').slice(0, 24);
  const canWrite = value => typeof value === 'string' && value.startsWith('docs/') && value.endsWith('.crnb');
  const resolveProject = id => id === projectId ? { root, canRead: canWrite, canWrite } : null;
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, stateRoot, projectId, canWrite, resolveProject };
}
function request(service, target, { credential, body, headers = {}, fingerprint = service.fingerprint } = {}) {
  const cert = JSON.parse(fs.readFileSync(path.join(service.stateRoot, 'identity.json'), 'utf8')).cert;
  return new Promise((resolve, reject) => {
    const req = https.request(service.describe().url + target, { method: body === undefined ? 'GET' : 'POST', ca: cert,
      agent: false, checkServerIdentity: (_, peer) => createHash('sha256').update(peer.raw).digest('hex') === fingerprint
        ? undefined : new Error('Pinned certificate mismatch'),
      headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), 'x-context-room-device-protocol': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, res => {
      const chunks = []; res.on('data', value => chunks.push(value)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function serviceFor(t, fixture) {
  const service = createConnectedDeviceService(fixture); service.stateRoot = fixture.stateRoot;
  await service.listen(); t.after(() => service.server.listening ? service.close() : undefined);
  return service;
}
const put = id => ({ kind: 'put', id, expectedRevision: 0, object: { id, type: 'rect', x: 10, y: 10, width: 80, height: 40 } });

test('TLS batches keep per-operation receipts, scope and targeted conflicts', async t => {
  const f = fixture(t), service = await serviceFor(t, f);
  const paired = service.authority.pair(service.createPairing({ projectId: f.projectId, paths: ['docs/Sketch.crnb'] }));
  const headers = { 'x-context-room-device-project': f.projectId };
  const api = (route, body) => request(service, route, { credential: paired.token, headers, body });
  const opened = (await api('/api/notebooks/open', { protocolVersion: 1, id: 'batch-book', path: 'docs/Sketch.crnb' })).body;
  const mutation = (operationId, edits) => ({ protocolVersion: 1, resourceId: opened.resourceId, locationRevision: opened.locator.revision, operationId, edits });
  const operations = [mutation('first', [put('one')]), mutation('conflicted', [put('one')]), mutation('independent', [put('two')])];
  const body = { protocolVersion: 1, resourceId: opened.resourceId, operations };
  const first = await api('/api/notebooks/batch', body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.results[0].receipt.status, 'confirmed');
  assert.equal(first.body.results[1].error.code, 'notebook_object_conflict');
  assert.equal(first.body.results[2].receipt.status, 'confirmed');
  assert.equal(first.body.snapshot.document.objects.length, 2);
  assert.equal((await api('/api/notebooks/batch', body)).body.snapshot.sequence, first.body.snapshot.sequence);
  assert.equal((await api('/api/notebooks/batch', { ...body, operations: [operations[0], operations[0]] })).status, 400);
  assert.equal((await api('/api/notebooks/batch', { ...body, operations: [{ ...operations[0], resourceId: 'another-book' }] })).status, 400);
  assert.equal((await api('/api/notebooks/batch', { ...body, operations: [{ ...mutation('escape', [put('escape')]), action: 'accept' }] })).status, 200);
  // Extra action fields do not turn a working mutation into a documentary decision.
  assert.equal(fs.existsSync(path.join(f.root, 'docs/Sketch.crnb')), false);
});

test('pairing is single-use, expires, persists only hashes and cannot grant owner review', t => {
  const f = fixture(t), identity = ensureDeviceIdentity(f.stateRoot); let time = Date.now();
  const authority = createDeviceAuthority({ stateRoot: f.stateRoot, serverId: identity.serverId, now: () => time });
  const grants = [{ mode: 'draw', projectId: f.projectId, root: f.root, rootIdentity: canonicalNotebookRoot(f.root), paths: ['docs/Sketch.crnb'] }];
  assert.throws(() => authority.createPairing({ grants: [{ ...grants[0], mode: 'owner' }] }), { code: 'device_scope_invalid' });
  assert.throws(() => authority.createPairing({ grants: [{ ...grants[0], paths: ['../escape.crnb'] }] }), { code: 'device_scope_invalid' });
  const expired = authority.createPairing({ grants }); time = expired.expiresAt;
  assert.throws(() => authority.pair(expired), { code: 'device_pairing_invalid' });
  const ticket = authority.createPairing({ grants });
  const paired = authority.pair(ticket);
  assert.throws(() => authority.pair(ticket), { code: 'device_pairing_invalid' });
  const persisted = fs.readFileSync(path.join(f.stateRoot, 'devices.json'), 'utf8');
  assert.equal(persisted.includes(ticket.token), false); assert.equal(persisted.includes(paired.token), false);
  assert.equal(fs.statSync(path.join(f.stateRoot, 'devices.json')).mode & 0o777, 0o600);
  const restarted = createDeviceAuthority({ stateRoot: f.stateRoot, serverId: identity.serverId, now: () => time });
  assert.equal(restarted.authenticate(paired.token).id, paired.device.id);
  restarted.revoke(paired.device.id);
  assert.throws(() => authority.authenticate(paired.token), { code: 'device_unauthorized' });
  const next = authority.pair(authority.createPairing({ grants })); time = next.device.expiresAt;
  assert.throws(() => authority.authenticate(next.token), { code: 'device_unauthorized' });
});

test('real TLS devices share the Mac scene, replay a lost receipt once and never acquire review authority', async t => {
  const f = fixture(t); let service = await serviceFor(t, f);
  const ticket = service.createPairing({ projectId: f.projectId, paths: ['docs/Sketch.crnb'], label: 'Synthetic tablet' });
  await assert.rejects(request(service, '/device/pair', { body: ticket, fingerprint: '0'.repeat(64) }), /Pinned certificate mismatch/);
  const paired = await request(service, '/device/pair', { body: ticket });
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  const credential = paired.body.token;
  const headers = { 'x-context-room-device-project': f.projectId };
  const api = (target, body, extra = {}) => request(service, target, { credential, headers: { ...headers, ...extra }, body });
  assert.equal((await request(service, '/device/pair', { body: ticket })).status, 403);
  assert.equal((await api('/api/notebooks', undefined, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await api('/api/notebooks', undefined, { 'x-context-room-device-project': '0'.repeat(24) })).status, 403);
  assert.equal((await api('/api/notebooks', undefined, { 'x-context-room-device-protocol': '99' })).status, 409);
  const opened = await api('/api/notebooks/open', { protocolVersion: 1, id: 'paired-sketch', path: 'docs/Sketch.crnb' });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const operation = { protocolVersion: 1, resourceId: opened.body.resourceId, locationRevision: opened.body.locator.revision, operationId: 'tablet-stroke', edits: [put('tablet-object')], actor: { kind: 'agent', id: 'spoofed' } };
  const receipt = await api('/api/notebooks/mutate', operation);
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(readNotebook(f.root, operation.resourceId).document.objects[0].createdBy.id, `device-${paired.body.device.id}`);
  mutateNotebook(f.root, { ...operation, operationId: 'mac-stroke', edits: [put('mac-object')] }, { actor: { kind: 'human', id: 'desktop' }, canWrite: f.canWrite });
  await service.close(); service = await serviceFor(t, f);
  const replayed = await api('/api/notebooks/mutate', operation);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body)); assert.equal(replayed.body.replayed, true);
  const snapshot = await api('/api/notebooks/scene?resourceId=paired-sketch');
  assert.equal(snapshot.body.document.objects.length, 2); assert.equal(snapshot.body.accepted, false);
  assert.equal(fs.existsSync(path.join(f.root, 'docs/Sketch.crnb')), false, 'collaboration must not publish accepted bytes');
  for (const route of ['/api/docqa/review', '/api/notebooks/submit', '/api/notebooks/freeze', '/api/devices/pair', '/api/shared-context/accept', '/api/notebooks/relocate']) {
    assert.equal((await api(route, operation)).status, 403, route);
  }
  assert.equal((await api('/api/notebooks/open', { protocolVersion: 1, path: 'docs/Other.crnb' })).status, 403);
  service.authority.revoke(paired.body.device.id);
  assert.equal((await api('/api/notebooks/scene?resourceId=paired-sketch')).status, 403);
});

test('device grants are invalid after replacing the authorized directory', async t => {
  const f = fixture(t), service = await serviceFor(t, f);
  const paired = service.authority.pair(service.createPairing({ projectId: f.projectId, paths: ['docs/Sketch.crnb'] }));
  fs.renameSync(f.root, path.join(f.base, 'original')); fs.mkdirSync(f.root);
  const response = await request(service, '/api/notebooks/open', { credential: paired.token,
    headers: { 'x-context-room-device-project': f.projectId }, body: { protocolVersion: 1, path: 'docs/Sketch.crnb' } });
  assert.equal(response.status, 409); assert.equal(response.body.code, 'device_project_changed');
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('pairing creation requires the real owner UI and inherits current Context Room folder permissions', async t => {
  const f = fixture(t), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) {
    previous[key] = process.env[key]; process.env[key] = path.join(f.base, key);
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  initializeContextRoomProject(f.root, { allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  const deviceService = createContextRoomDeviceService({ root: f.root, stateRoot: f.stateRoot });
  await deviceService.listen(); t.after(() => deviceService.close());
  const room = createMemoryServer({ root: f.root, deviceService });
  await new Promise(resolve => room.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { room.server.closeAllConnections(); room.server.close(resolve); }));
  const post = async (paths, nonce = room.ownerMutationNonce) => fetch(`http://127.0.0.1:${room.server.address().port}/api/devices/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-context-room-owner-nonce': nonce, 'x-context-room-project': room.projectId }, body: JSON.stringify({ paths }) });
  assert.equal((await post(['docs/Sketch.crnb'], '')).status, 403);
  assert.equal((await post(['private/Hidden.crnb'])).status, 400);
  const response = await post(['docs/Sketch.crnb']);
  assert.equal(response.status, 201);
  const ticket = await response.json(); assert.equal(ticket.fingerprint, deviceService.fingerprint);
  assert.deepEqual(ticket.grants, [{ mode: 'draw', projectId: room.projectId, paths: ['docs/Sketch.crnb'] }]);
});

test('unsafe or replaced device storage fails closed without touching a linked file', t => {
  const f = fixture(t), identity = ensureDeviceIdentity(f.stateRoot);
  const authority = createDeviceAuthority({ stateRoot: f.stateRoot, serverId: identity.serverId });
  const outside = path.join(f.base, 'outside.json'); fs.writeFileSync(outside, 'untouched');
  fs.symlinkSync(outside, path.join(f.stateRoot, 'devices.json'));
  assert.throws(() => authority.list(), { code: 'notebook_path_scope' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  fs.unlinkSync(path.join(f.stateRoot, 'devices.json'));
  fs.renameSync(f.stateRoot, path.join(f.base, 'old-devices')); fs.mkdirSync(f.stateRoot, { mode: 0o700 });
  assert.throws(() => authority.list(), { code: 'device_storage_changed' });
});

test('revocation during an upload is checked again before the scene can change', async t => {
  const f = fixture(t), service = await serviceFor(t, f);
  const scene = openNotebook(f.root, { path: 'docs/Sketch.crnb', id: 'delayed-upload', canWrite: f.canWrite });
  const paired = service.authority.pair(service.createPairing({ projectId: f.projectId, paths: ['docs/Sketch.crnb'] }));
  const cert = JSON.parse(fs.readFileSync(path.join(f.stateRoot, 'identity.json'), 'utf8')).cert;
  let arrived;
  const uploading = new Promise(resolve => { arrived = resolve; });
  service.server.once('request', () => arrived());
  let outgoing;
  const response = new Promise((resolve, reject) => {
    outgoing = https.request(service.describe().url + '/api/notebooks/mutate', { method: 'POST', ca: cert, agent: false,
      checkServerIdentity: (_, peer) => createHash('sha256').update(peer.raw).digest('hex') === service.fingerprint ? undefined : new Error('pin mismatch'),
      headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json',
        'x-context-room-device-project': f.projectId, 'x-context-room-device-protocol': '1' } }, result => {
      result.resume(); result.once('end', () => resolve(result.statusCode));
    });
    outgoing.once('error', reject); outgoing.write('{');
  });
  await uploading;
  service.authority.revoke(paired.device.id);
  outgoing.end(JSON.stringify({ protocolVersion: 1, resourceId: scene.resourceId, operationId: 'delayed', locationRevision: scene.locator.revision, edits: [put('unwanted')] }).slice(1));
  assert.equal(await response, 403);
  assert.equal(readNotebook(f.root, scene.resourceId).document.objects.length, 0);
});

test('pairing guesses are bounded and native credentials cannot unlock normalized or browser routes', async t => {
  const f = fixture(t), service = await serviceFor(t, f);
  const paired = service.authority.pair(service.createPairing({ projectId: f.projectId, paths: ['docs/Sketch.crnb'] }));
  for (let n = 0; n < 10; n++) assert.equal((await request(service, '/device/pair', { body: { protocolVersion: 1, pairingId: 'missing', token: 'A'.repeat(43) } })).status, 403);
  assert.equal((await request(service, '/device/pair', { body: { protocolVersion: 1, pairingId: 'missing', token: 'A'.repeat(43) } })).status, 429);
  for (const target of ['/api/%6eotebooks', '/api/notebooks//scene', '/api/agent/capabilities', '/']) {
    const result = await request(service, target, { credential: paired.token, headers: { 'x-context-room-device-project': f.projectId } });
    assert.ok([403, 404].includes(result.status), target);
  }
  assert.equal((await request(service, '/device/session', { credential: paired.token, headers: { origin: 'https://document.invalid' } })).status, 403);
});

test('CLI starts an optional device listener alongside its unchanged loopback Hub', { timeout: 30_000 }, async t => {
  const f = fixture(t), reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, HOME: f.base, CONTEXT_ROOM_HUB_HOME: path.join(f.base, 'hub'),
    CONTEXT_ROOM_SHARED_HOME: path.join(f.base, 'shared'), CONTEXT_ROOM_REVIEW_AUTHORITY_HOME: path.join(f.base, 'owner') };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url)), 'setup',
    '--root', f.root, '--allow', 'docs/', '--watch', 'docs/', '--port', String(port), '--device-host', '127.0.0.1', '--device-port', '0'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Device-enabled CLI did not become ready: ' + output)), 20_000);
    const ready = () => { if (output.includes('Context Room Hub:')) { clearTimeout(timer); child.stdout.off('data', ready); resolve(); } };
    child.stdout.on('data', ready); child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${output}`)); }); ready();
  });
  const state = await (await fetch(`http://127.0.0.1:${port}/api/devices`)).json();
  assert.equal(state.enabled, true); assert.match(state.url, /^https:\/\/127\.0\.0\.1:\d+$/); assert.deepEqual(state.devices, []);
  assert.equal(fs.existsSync(path.join(f.base, 'hub/devices/identity.json')), true);
  assert.equal(fs.existsSync(path.join(f.root, 'identity.json')), false);
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); assert.equal(health.ok, true);
});

test('revocation while a notebook writer waits for its lock prevents a later commit', { timeout: 15_000 }, async t => {
  const f = fixture(t), service = await serviceFor(t, f);
  const scene = openNotebook(f.root, { path: 'docs/Sketch.crnb', id: 'locked-upload', canWrite: f.canWrite });
  const paired = service.authority.pair(service.createPairing({ projectId: f.projectId, paths: ['docs/Sketch.crnb'] }));
  const relativeLock = `${NOTEBOOK_STORE}/resources/locked-upload/mutation.lock`;
  const lockPath = path.join(f.root, relativeLock);
  const code = `import fs from 'node:fs';
    import { withNotebookLock } from ${JSON.stringify(new URL('../src/notebook_io.mjs', import.meta.url).href)};
    import { createDeviceAuthority } from ${JSON.stringify(new URL('../src/device_authority.mjs', import.meta.url).href)};
    const [root, stateRoot, serverId, deviceId, lock] = process.argv.slice(1);
    withNotebookLock(root, lock, () => {
      fs.writeSync(1, 'locked\\n'); fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      createDeviceAuthority({ stateRoot, serverId }).revoke(deviceId);
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.root, f.stateRoot, service.serverId, paired.device.id, relativeLock], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await new Promise((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error(errors || 'Lock holder exited early'))); });
  const link = fs.linkSync; let waiting = false;
  fs.linkSync = (from, to) => {
    if (to === lockPath && !waiting) { waiting = true; child.stdin.end('x'); }
    return link(from, to);
  };
  try {
    const result = await request(service, '/api/notebooks/mutate', { credential: paired.token,
      headers: { 'x-context-room-device-project': f.projectId }, body: { protocolVersion: 1, resourceId: scene.resourceId,
        operationId: 'blocked-write', locationRevision: scene.locator.revision, edits: [put('must-not-appear')] } });
    assert.equal(waiting, true, 'the upload reached the notebook mutation lock');
    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert.equal(await exited, 0, errors);
    assert.equal(readNotebook(f.root, scene.resourceId).document.objects.length, 0);
  } finally { fs.linkSync = link; }
});
