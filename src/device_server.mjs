import https from 'node:https';
import { isIP } from 'node:net';
import { canonicalNotebookRoot } from './notebook_io.mjs';
import { handleNotebookHttp } from './notebook_http.mjs';
import { createDeviceAuthority, deviceError, DEVICE_PROTOCOL, ensureDeviceIdentity } from './device_authority.mjs';

const GET_ROUTES = new Set(['/api/notebooks', '/api/notebooks/capabilities', '/api/notebooks/scene', '/api/notebooks/receipt', '/api/notebooks/export']);
const POST_ROUTES = new Set(['/api/notebooks/open', '/api/notebooks/mutate', '/api/notebooks/undo', '/api/notebooks/asset']);
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
  res.end(JSON.stringify(value));
}
async function readBody(req, maxBytes, budget) {
  if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || '')) || req.headers['content-encoding']) {
    throw deviceError('device_content_type', 'Send uncompressed JSON.', 415);
  }
  if (Number(req.headers['content-length'] || 0) > maxBytes) throw deviceError('device_body_limit', 'This request is too large.', 413);
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length; budget.bytes += chunk.length;
      if (bytes > maxBytes || budget.bytes > 64 * 1024 * 1024) throw deviceError('device_body_limit', 'This request is too large or other transfers are busy.', 413);
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch (error) {
    if (error?.code === 'device_body_limit') throw error;
    throw deviceError('device_json', 'Invalid JSON request.', 400);
  } finally { budget.bytes -= bytes; }
}
function bearer(req) {
  if (req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization').length !== 1) return '';
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization || ''));
  return match?.[1] || '';
}

/** Optional native-device listener; never forwards arbitrary requests to the owner UI. */
export function createConnectedDeviceService({ stateRoot, resolveProject, now = Date.now } = {}) {
  if (typeof resolveProject !== 'function') throw new TypeError('An existing Context Room project resolver is required.');
  const identity = ensureDeviceIdentity(stateRoot);
  const authority = createDeviceAuthority({ stateRoot, serverId: identity.serverId, now });
  const bodyBudget = { bytes: 0 };
  const rates = new Map();
  function limit(key, maximum, period = 60_000) {
    const time = now();
    for (const [id, item] of rates) if (item.reset <= time) rates.delete(id);
    const item = rates.get(key) || { count: 0, reset: time + period };
    if (rates.size >= 1024 && !rates.has(key)) throw deviceError('device_rate_limit', 'Try again later.', 429);
    item.count += 1; rates.set(key, item);
    if (item.count > maximum) throw deviceError('device_rate_limit', 'Try again later.', 429);
  }
  function projectFor(scope) {
    const project = resolveProject(scope.projectId);
    if (!project || project.root !== scope.root || canonicalNotebookRoot(project.root) !== scope.rootIdentity) {
      throw deviceError('device_project_changed', 'The authorized project is unavailable or was replaced.', 409);
    }
    return project;
  }
  const server = https.createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2',
    maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    try {
      // Native credentials are never made available to pages or embedded HTML.
      if (req.headers.origin || req.headers.referer || req.headers['sec-fetch-site']) {
        throw deviceError('device_browser_forbidden', 'Use the paired native device client.');
      }
      if (!req.socket.encrypted || !req.headers.host || String(req.headers.host).length > 255) {
        throw deviceError('device_transport', 'An encrypted device connection is required.');
      }
      limit(`incoming:${req.socket.remoteAddress}`, 1800);
      if (req.method === 'GET' && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0)) {
        throw deviceError('device_body_unexpected', 'Read requests do not accept a body.', 400);
      }
      const raw = String(req.url || '');
      const rawPath = raw.split('?')[0];
      const url = new URL(raw, 'https://context-room.invalid');
      if (!raw.startsWith('/') || raw.startsWith('//') || rawPath !== url.pathname || /[%\\#]/.test(rawPath) || url.hash) {
        throw deviceError('device_route', 'Unknown device route.', 404);
      }
      if (req.method === 'POST' && url.pathname === '/device/pair') {
        limit('pair:global', 60);
        limit(`pair:${req.socket.remoteAddress}`, 10);
        const body = await readBody(req, 8192, bodyBudget);
        json(res, 201, authority.pair(body));
        return;
      }
      const credential = bearer(req);
      const initialDevice = authority.authenticate(credential);
      limit(`request:${initialDevice.id}`, 1200);
      if (req.headers['x-context-room-device-protocol'] !== String(DEVICE_PROTOCOL)) {
        throw deviceError('device_protocol', 'Update the device client before continuing.', 409);
      }
      if (req.method === 'GET' && url.pathname === '/device/session') {
        json(res, 200, { protocolVersion: DEVICE_PROTOCOL, serverId: identity.serverId,
          device: { ...initialDevice, grants: initialDevice.grants.map(({ root, rootIdentity, ...scope }) => scope) } });
        return;
      }
      if (!(req.method === 'GET' && GET_ROUTES.has(url.pathname) || req.method === 'POST' && POST_ROUTES.has(url.pathname))) {
        throw deviceError('device_operation_forbidden', 'This operation is outside the drawing permission.');
      }
      const body = req.method === 'POST' ? await readBody(req, 30 * 1024 * 1024, bodyBudget) : null;
      // Recheck revocation and expiry after any delayed body upload.
      const device = authority.authenticate(credential);
      const projectId = String(req.headers['x-context-room-device-project'] || '');
      const scope = device.grants.find(item => item.projectId === projectId);
      if (!scope) throw deviceError('device_project_scope', 'This project is outside the device permission.');
      const project = projectFor(scope);
      const permitted = (rel, write) => {
        // The notebook engine invokes this again inside its mutation lock.
        // A device revoked while waiting for that lock must not commit later.
        const live = authority.authenticate(credential).grants.find(item => item.projectId === projectId
          && item.root === scope.root && item.rootIdentity === scope.rootIdentity);
        if (!live || !live.paths.includes(rel)) return false;
        const current = projectFor(live);
        return write ? current.canWrite(rel) : current.canRead(rel);
      };
      const canRead = rel => permitted(rel, false), canWrite = rel => permitted(rel, true);
      await handleNotebookHttp(req, res, { root: project.root, url, readJsonBody: async () => body,
        sendJson: (response, status, result) => json(response, status, url.pathname === '/api/notebooks/capabilities'
          ? { ...result, serverId: identity.serverId, accountId: `device:${device.id}:project:${projectId}`,
            deviceId: device.id, projectId, reviewAuthority: 'unavailable', operations: ['open', 'read', 'mutate', 'undo', 'asset', 'receipt', 'export'] }
          : result),
        canRead, canWrite, actor: { kind: 'human', id: `device-${device.id}` } });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      // Internal exceptions can contain filesystem paths; return only the protocol failure.
      const known = typeof error.code === 'string' && /^(device|notebook)_/.test(error.code);
      json(res, known ? (error.statusCode || 400) : 500,
        { error: known ? error.message : 'The device operation failed. The Mac keeps the last acknowledged state.', code: known ? error.code : 'device_internal' });
    }
  });
  server.maxConnections = 64;
  server.setTimeout(15_000);
  server.on('checkContinue', (req, res) => { json(res, 417, { code: 'device_expectation', error: 'Streaming expectations are unsupported.' }); });
  return {
    server,
    serverId: identity.serverId,
    fingerprint: identity.fingerprint,
    authority,
    describe() {
      const address = server.address();
      if (!address || typeof address === 'string') throw deviceError('device_service_unavailable', 'The device listener is not running.', 503);
      const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      return { protocolVersion: DEVICE_PROTOCOL, serverId: identity.serverId, fingerprint: identity.fingerprint,
        url: `https://${host}:${address.port}`, certificateExpiresAt: identity.expiresAt };
    },
    async listen({ host = '127.0.0.1', port = 0 } = {}) {
      if (!isIP(host) || ['0.0.0.0', '::'].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw deviceError('device_bind_invalid', 'Choose an explicit local IP address and port.', 400);
      }
      await new Promise((resolve, reject) => {
        const fail = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail); server.once('listening', ready); server.listen(port, host);
      });
      return { host, port: server.address().port, serverId: identity.serverId, fingerprint: identity.fingerprint };
    },
    close() { return new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }); },
    createPairing({ projectId, paths, label }) {
      const project = resolveProject(projectId);
      if (!project || !Array.isArray(paths) || paths.some(rel => !project.canRead(rel) || !project.canWrite(rel))) {
        throw deviceError('device_scope_invalid', 'Choose notebooks inside the project folders authorized by the owner.', 400);
      }
      const grant = { mode: 'draw', projectId, root: project.root, rootIdentity: canonicalNotebookRoot(project.root), paths };
      return { ...authority.createPairing({ grants: [grant], label }), fingerprint: identity.fingerprint };
    },
  };
}
