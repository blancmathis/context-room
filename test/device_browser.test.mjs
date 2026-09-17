import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { browserTlsConfiguration } from '../src/device_browser.mjs';
import { readNotebook } from '../src/notebooks.mjs';
import { browserDeviceFixture } from './fixtures/browser_device.mjs';

test('trusted browser TLS uses an explicit chain and does not replace the native pinned identity', async t => {
  const f = await browserDeviceFixture(t);
  assert.equal((await f.request('/')).status, 200);
  await assert.rejects(f.request('/', { trusted: false }), /certificate|issuer|verify/i);
  const identity = fs.readFileSync(path.join(f.base, 'devices/identity.json'));
  assert.throws(() => browserTlsConfiguration({ ...f.config, origin: 'http://localhost' }), { code: 'device_browser_origin' });
  assert.throws(() => browserTlsConfiguration({ ...f.config, origin: 'https://wrong.example.test' }), { code: 'device_browser_tls_identity' });
  assert.throws(() => browserTlsConfiguration({ ...f.config, keyPath: path.join(f.base, 'ca-key.pem') }), /private|match/);
  fs.chmodSync(f.config.keyPath, 0o644);
  assert.throws(() => browserTlsConfiguration(f.config), { code: 'device_browser_tls_file' });
  assert.deepEqual(fs.readFileSync(path.join(f.base, 'devices/identity.json')), identity);
  assert.notEqual(f.service.describe().url, f.origin); assert.equal(f.service.describe().browserUrl, f.origin);
});

test('browser pairing is one-use, cookie-only, same-origin and cannot escalate a drawing grant', async t => {
  const f = await browserDeviceFixture(t), paired = await f.pair();
  assert.equal(paired.response.json().token, undefined);
  for (const flag of ['__Host-', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(paired.response.headers['set-cookie'][0].includes(flag));
  assert.equal((await f.request('/browser/pair', { method: 'POST', body: paired.ticket })).status, 403);
  const auth = { cookie: paired.cookie, deviceId: paired.deviceId };
  const session = (await f.request('/browser/session', auth)).json();
  assert.equal(session.device.grants[0].root, undefined);
  assert.match((await f.request('/', auth)).text, /content="draw"/);
  assert.equal((await f.request('/api/files', auth)).status, 403);
  assert.equal((await f.request('/api/devices/pair-owner', { ...auth, method: 'POST', body: { mode: 'owner' } })).status, 403);
  const headers = { 'x-context-room-device-project': f.room.projectId };
  const open = { protocolVersion: 1, id: 'browser-sketch', path: 'docs/Sketch.crnb' };
  const response = await f.request('/api/notebooks/open', { ...auth, headers, method: 'POST', body: open });
  assert.equal(response.status, 200, response.text);
  assert.equal((await f.request('/api/notebooks/open', { ...auth, headers, method: 'POST', body: { ...open, id: 'private-sketch', path: 'private/Secret.crnb' } })).status, 403);
  assert.equal(fs.existsSync(path.join(f.root, 'docs/Sketch.crnb')), false);
  const cap = (await f.request('/api/notebooks/capabilities', { ...auth, headers })).json(); assert.equal(cap.reviewAuthority, 'unavailable');
  for (const badHeaders of [{ origin: 'https://outside.example.test' }, { 'sec-fetch-site': 'same-site' }, { host: 'localhost:' + new URL(f.origin).port }, { 'x-forwarded-host': 'other.example.test' }]) {
    assert.equal((await f.request('/browser/session', { ...auth, headers: badHeaders })).status, 403);
  }
  assert.equal((await f.request('/browser/logout', { ...auth, method: 'POST', headers: { origin: '' } })).status, 403);
  assert.equal((await f.request('/browser/logout', { ...auth, method: 'POST', deviceId: 'different' })).status, 403);
  assert.equal((await f.request('/browser/session', { cookie: paired.cookie + '; ' + paired.cookie })).status, 403);
  assert.equal((await f.request('/browser/logout', { ...auth, method: 'POST' })).status, 200);
  assert.equal((await f.request('/browser/session', auth)).status, 403);
  assert.equal((await f.request('/offline.html', auth)).status, 200, 'Revocation does not erase public application/recovery bytes');
});

test('browser owner uses the same nonce and project checks; a replacement pairing cannot send an old outbox', async t => {
  const f = await browserDeviceFixture(t), first = await f.pair(true), second = await f.pair(true);
  const page = await f.request('/', first);
  assert.match(page.text, new RegExp(first.deviceId)); assert.ok(page.text.includes(f.room.ownerMutationNonce));
  const body = { protocolVersion: 1, id: 'owner-browser-sketch', path: 'docs/Owner.crnb' };
  const headers = { 'x-context-room-project': f.room.projectId };
  assert.equal((await f.request('/api/notebooks/open', { ...first, headers, body, method: 'POST' })).status, 403);
  headers['x-context-room-owner-nonce'] = f.room.ownerMutationNonce;
  assert.equal((await f.request('/api/notebooks/open', { ...second, deviceId: first.deviceId, headers, body, method: 'POST' })).status, 403);
  assert.equal((await f.request('/api/notebooks/open', { ...first, headers, body, method: 'POST' })).status, 200);
  const cap = (await f.request('/api/notebooks/capabilities', { ...first, headers })).json(); assert.equal(cap.accountId, 'browser:' + first.deviceId);
  assert.equal((await f.request('/api/devices/pair-owner', { ...first, headers, body: { mode: 'owner' }, method: 'POST' })).status, 403);
  assert.equal(readNotebook(f.root, body.id).document.objects.length, 0);
  f.service.authority.revoke(first.deviceId);
  assert.equal((await f.request('/api/notebooks/capabilities', { ...first, headers })).status, 403);
});

test('browser revocation during a delayed upload is checked before the notebook lock can commit', async t => {
  const f = await browserDeviceFixture(t), paired = await f.pair();
  const body = JSON.stringify({ protocolVersion: 1, id: 'late-browser-sketch', path: 'docs/Sketch.crnb' });
  let req;
  const response = new Promise((resolve, reject) => {
    req = https.request(f.origin + '/api/notebooks/open', { ca: f.ca, method: 'POST', agent: false, headers: { origin: f.origin, cookie: paired.cookie,
      'x-context-room-browser-device': paired.deviceId, 'x-context-room-device-project': f.room.projectId, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.flushHeaders(); req.write(body.slice(0, 10));
  });
  await new Promise(resolve => setTimeout(resolve, 30)); f.service.authority.revoke(paired.deviceId); req.end(body.slice(10));
  assert.equal(await response, 403); assert.throws(() => readNotebook(f.root, 'late-browser-sketch'));
});
