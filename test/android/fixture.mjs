/** Isolated Android acceptance fixture. Never points to a registered personal project. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createConnectedDeviceService } from '../../src/device_server.mjs';
import { openNotebook, readNotebook, mutateNotebook } from '../../src/notebooks.mjs';

const [directory] = process.argv.slice(2);
if (!directory || !path.isAbsolute(directory) || fs.existsSync(directory)) throw new Error('Choose a new absolute private fixture directory.');
fs.mkdirSync(directory, { mode: 0o700 });
const base = fs.realpathSync(directory), root = path.join(base, 'project');
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
const projectId = createHash('sha256').update(root).digest('hex').slice(0, 24);
const allowed = rel => ['docs/Tablet.crnb', 'docs/Second.crnb'].includes(rel);
const service = createConnectedDeviceService({ stateRoot: path.join(base, 'device-state'), resolveProject: id => id === projectId ? { root, canRead: allowed, canWrite: allowed } : null });
const scene = openNotebook(root, { path: 'docs/Tablet.crnb', id: 'android-acceptance', title: 'Carnet de vérification', canWrite: allowed });
const second = openNotebook(root, { path: 'docs/Second.crnb', id: 'android-second', title: 'Autre carnet', canWrite: allowed });
mutateNotebook(root, { protocolVersion: 1, resourceId: second.resourceId, locationRevision: second.locator.revision, operationId: 'mac-second-initial', edits: [
  { kind: 'put', id: 'mac-box', expectedRevision: 0, object: { id: 'mac-box', type: 'rect', x: 300, y: 100, width: 180, height: 100, color: '#000000', fill: '#ffffff', strokeWidth: 3 } },
  { kind: 'put', id: 'mac-label', expectedRevision: 0, object: { id: 'mac-label', type: 'text', x: 310, y: 130, width: 150, height: 40, text: 'Second carnet', fontSize: 20, color: '#000000' } },
] }, { actor: { kind: 'human', id: 'mac-fixture' }, canWrite: allowed });
mutateNotebook(root, { protocolVersion: 1, resourceId: scene.resourceId, locationRevision: scene.locator.revision, operationId: 'mac-initial', edits: [
  { kind: 'put', id: 'mac-box', expectedRevision: 0, object: { id: 'mac-box', type: 'rect', x: 300, y: 100, width: 180, height: 100, color: '#000000', fill: '#ffffff', strokeWidth: 3 } },
  { kind: 'put', id: 'mac-label', expectedRevision: 0, object: { id: 'mac-label', type: 'text', x: 310, y: 130, width: 150, height: 40, text: 'Depuis le Mac', fontSize: 20, color: '#000000' } },
] }, { actor: { kind: 'human', id: 'mac-fixture' }, canWrite: allowed });
await service.listen();
let devicePort = service.server.address().port;
const owner = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture.invalid'); let data;
    if (req.method === 'POST' && url.pathname === '/ticket') {
      data = { ...service.describe(), ...service.createPairing({ projectId, paths: ['docs/Tablet.crnb', 'docs/Second.crnb'], label: 'Tablette de vérification' }), url: `https://10.0.2.2:${devicePort}` };
      fs.writeFileSync(path.join(base, 'ticket.json'), JSON.stringify(data), { mode: 0o600 });
      data = { path: path.join(base, 'ticket.json') };
    } else if (req.method === 'GET' && url.pathname === '/scene') data = readNotebook(root, url.searchParams.get('target') === 'second' ? second.resourceId : scene.resourceId);
    else if (req.method === 'POST' && url.pathname === '/open') {
      const device = service.authority.list().find(item => !item.revokedAt);
      data = service.navigation.request({ deviceId: device.id, projectId, operationId: url.searchParams.get('operationId'), resourceId: url.searchParams.get('target') === 'second' ? second.resourceId : scene.resourceId });
    } else if (req.method === 'GET' && url.pathname === '/navigation') {
      const device = service.authority.list().find(item => !item.revokedAt);
      data = service.navigation.inspect(device.id, url.searchParams.get('operationId') || '');
    } else if (req.method === 'POST' && url.pathname === '/view') {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) throw new Error('Fixture view request too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const current = readNotebook(root, scene.resourceId, { includeDocument: false });
      const device = service.authority.list().find(item => !item.revokedAt);
      data = service.navigation.view({ ...body, sessionId: 'android-fixture-owner', deviceId: device.id, projectId,
        target: { projectId, resourceId: scene.resourceId, path: scene.locator.path, locationRevision: current.locator.revision } });
    }
    else if (req.method === 'POST' && url.pathname === '/offline') { if (service.server.listening) await service.close(); data = { online: false }; }
    else if (req.method === 'POST' && url.pathname === '/online') { if (!service.server.listening) await service.listen({ port: devicePort }); data = { online: true }; }
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data));
  } catch { res.writeHead(500); res.end('{"error":"fixture_failed"}'); }
});
await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(base, 'fixture.json'), JSON.stringify({ ownerUrl: `http://127.0.0.1:${owner.address().port}`, serverId: service.describe().serverId, projectId, resourceId: scene.resourceId }), { mode: 0o600 });
process.stdout.write('Isolated Android fixture ready.\n');
async function close() { owner.closeAllConnections(); owner.close(); if (service.server.listening) await service.close(); }
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
