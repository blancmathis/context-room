import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createContextRoomDeviceService, createMemoryServer, initializeContextRoomProject } from '../../src/context_room.mjs';

export async function browserDeviceFixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-browser-device-'))), root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { previous[key] = process.env[key]; process.env[key] = path.join(base, key); }
  const run = args => execFileSync('openssl', args, { cwd: base, stdio: 'ignore', timeout: 20_000 });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca-key.pem', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Synthetic Context Room test CA']);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'request.csr', '-subj', '/CN=localhost']);
  fs.writeFileSync(path.join(base, 'extensions.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  run(['x509', '-req', '-in', 'request.csr', '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-CAcreateserial', '-out', 'cert.pem', '-days', '2', '-extfile', 'extensions.cnf']);
  fs.chmodSync(path.join(base, 'key.pem'), 0o600);
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, config = { origin, certPath: path.join(base, 'cert.pem'), keyPath: path.join(base, 'key.pem') };
  initializeContextRoomProject(root, { title: 'Synthetic browser device', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  const service = createContextRoomDeviceService({ root, stateRoot: path.join(base, 'devices'), browser: config });
  const room = createMemoryServer({ root, deviceService: service });
  await new Promise(resolve => room.server.listen(0, '127.0.0.1', resolve)); await service.listen();
  t.after(async () => { await service.close(); await new Promise(resolve => { room.server.closeAllConnections(); room.server.close(resolve); }); await room.waitForShutdown(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(base, { recursive: true, force: true }); });
  const ca = fs.readFileSync(path.join(base, 'ca.pem'));
  function request(target, { method = 'GET', cookie = '', deviceId = '', body, headers = {}, trusted = true } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(origin + target, { method, ...(trusted ? { ca } : {}), agent: false, headers: {
        ...(cookie ? { cookie } : {}), ...(deviceId ? { 'x-context-room-browser-device': deviceId } : {}),
        ...(!['GET', 'HEAD'].includes(method) ? { origin, 'content-type': 'application/json' } : {}), ...headers,
      } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); }); });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function pair(owner = false) {
    const ticket = owner ? service.createOwnerPairing() : service.createPairing({ projectId: room.projectId, paths: ['docs/Sketch.crnb'] });
    const response = await request('/browser/pair', { method: 'POST', body: ticket });
    if (response.status !== 201) throw new Error(response.text);
    return { ticket, response, cookie: response.headers['set-cookie'][0].split(';')[0], deviceId: response.json().device.id };
  }
  return { base, root, service, room, config, ca, origin, request, pair };
}
