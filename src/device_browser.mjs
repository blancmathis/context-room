/** Optional trusted-HTTPS browser edge. It reuses the existing device authority. */
import fs from 'node:fs';
import https from 'node:https';
import { isIP } from 'node:net';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { deviceError } from './device_authority.mjs';
import { publicWebPaths, webAppResponse, webAppVersion, webEntryHtml } from './web_app.mjs';

const COOKIE = '__Host-context-room-device';
const FORWARD_HEADERS = new Set(['accept', 'content-type', 'range', 'if-none-match', 'last-event-id',
  'x-context-room-project', 'x-context-room-target-project', 'x-context-room-owner-nonce',
  'x-context-room-prompt-nonce', 'x-context-room-notebook-client']);
export function browserTlsConfiguration({ origin, certPath, keyPath } = {}) {
  let url;
  try { url = new URL(origin); } catch { throw deviceError('device_browser_origin', 'Supply an exact trusted HTTPS browser origin.', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || ['0.0.0.0', '[::]'].includes(url.hostname)) throw deviceError('device_browser_origin', 'Supply an exact HTTPS hostname and port, without a path or credentials.', 400);
  const read = (file, privateKey) => {
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 128 * 1024 || privateKey && ((stat.mode & 0o077) || process.getuid && stat.uid !== process.getuid())) throw new Error();
      return fs.readFileSync(fd);
    } catch { throw deviceError('device_browser_tls_file', 'Use a bounded certificate chain and a private, owner-only regular key file outside the repository.', 400); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const cert = read(certPath, false), key = read(keyPath, true);
  try {
    const certificate = new X509Certificate(cert), hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname, { subject: 'never' }))
      || Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()
      || !certificate.checkPrivateKey(createPrivateKey(key))) throw new Error();
  } catch { throw deviceError('device_browser_tls_identity', 'The certificate must be current, match the HTTPS hostname and match the private key.', 400); }
  // Browser trust is deliberately NOT inferred from these checks or native pinning.
  return { origin: url.origin, host: url.host, port: Number(url.port || 443), cert, key };
}
function credential(req) {
  const values = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(COOKIE + '='));
  if (values.length !== 1) return '';
  return values[0].slice(COOKIE.length + 1);
}
function sessionCookie(token, seconds = 0) { return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`; }
function safeDevice(device) { return { ...device, grants: device.grants.map(({ root, rootIdentity, ...grant }) => grant) }; }

export function createBrowserDeviceService({ config, authority, serverId, owner, drawing, navigation, getWebBundle, now = Date.now }) {
  const tls = browserTlsConfiguration(config), rates = new Map(); let uploaded = 0;
  const isOwner = device => device.grants.some(g => g.mode === 'owner' && g.serverId === serverId);
  function limit(key, max) {
    const time = now(); for (const [id, item] of rates) if (item.until <= time) rates.delete(id);
    if (rates.size >= 1024 && !rates.has(key)) throw deviceError('device_rate_limit', 'Try again later.', 429);
    const value = rates.get(key) || { until: time + 60_000, count: 0 }; value.count++; rates.set(key, value);
    if (value.count > max) throw deviceError('device_rate_limit', 'Try again later.', 429);
  }
  async function read(req, max = 30 * 1024 * 1024) {
    if (req.headers['content-encoding'] || Number(req.headers['content-length'] || 0) > max) throw deviceError('device_body_limit', 'This request is too large or compressed.', 413);
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length; uploaded += chunk.length;
        if (bytes > max || uploaded > 64 * 1024 * 1024) throw deviceError('device_body_limit', 'This upload is too large or the connection is busy.', 413);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally { uploaded -= bytes; }
  }
  function json(res, status, data, extra = {}) {
    send(res, { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra }, body: JSON.stringify(data) });
  }
  function send(res, { status = 200, headers = {}, body = '' }, method = 'GET') {
    res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin', 'content-security-policy': "frame-ancestors 'none'; base-uri 'none'", ...headers });
    res.end(method === 'HEAD' ? undefined : body);
  }
  const server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2', maxHeaderSize: 16_384,
    requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    try {
      if (!req.socket.encrypted || req.headers.host !== tls.host || req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'host').length !== 1
        || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto']) throw deviceError('device_browser_host', 'Use the configured HTTPS origin directly.');
      if (req.headers.origin && req.headers.origin !== tls.origin
        || req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) throw deviceError('device_browser_origin', 'Cross-origin device requests are forbidden.');
      if (req.headers.referer && new URL(req.headers.referer).origin !== tls.origin) throw deviceError('device_browser_origin', 'Cross-origin device requests are forbidden.');
      const readOnly = ['GET', 'HEAD'].includes(req.method);
      if (!readOnly && req.headers.origin !== tls.origin) throw deviceError('device_browser_origin', 'A same-origin browser action is required.');
      if (readOnly && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0))) throw deviceError('device_body_unexpected', 'Read requests do not accept a body.', 400);
      const raw = String(req.url || ''), url = new URL(raw, tls.origin);
      if (!raw.startsWith('/') || raw.startsWith('//') || /[\\#\x00-\x20]/.test(raw) || raw.split('?')[0] !== url.pathname) throw deviceError('device_browser_route', 'Invalid browser route.', 404);
      limit('incoming:' + req.socket.remoteAddress, 1800);
      const bundle = getWebBundle();
      if (readOnly && publicWebPaths(bundle).has(url.pathname)) {
        const asset = webAppResponse(url, bundle) || { headers: { 'content-type': url.pathname === bundle.cssPath ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }, body: url.pathname === bundle.cssPath ? bundle.css : bundle.js };
        send(res, asset, req.method); return;
      }
      if (req.method === 'POST' && url.pathname === '/browser/pair') {
        limit('pair:global', 60); limit('pair:' + req.socket.remoteAddress, 10);
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw deviceError('device_content_type', 'Send JSON.', 415);
        let ticket; try { ticket = JSON.parse((await read(req, 8192)).toString('utf8')); } catch (error) { if (error.code) throw error; throw deviceError('device_json', 'Invalid pairing JSON.', 400); }
        if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) throw deviceError('device_json', 'A pairing object is required.', 400);
        if (ticket.serverId !== serverId) throw deviceError('device_pairing_server', 'This pairing belongs to a different Mac.');
        const paired = authority.pair(ticket);
        json(res, 201, { protocolVersion: paired.protocolVersion, serverId, device: paired.device }, { 'set-cookie': sessionCookie(paired.token, Math.max(0, Math.floor((paired.device.expiresAt - now()) / 1000))) }); return;
      }
      const token = credential(req);
      let device;
      try { device = authority.authenticate(token); }
      catch (error) {
        if (readOnly && url.pathname === '/') { send(res, { headers: { 'content-type': 'text/html; charset=utf-8' }, body: webEntryHtml(bundle, { mode: 'pair' }) }, req.method); return; }
        throw error;
      }
      const authenticate = () => authority.authenticate(token);
      limit('device:' + device.id, 1200);
      if (!readOnly && req.headers['x-context-room-browser-device'] !== device.id) throw deviceError('device_browser_session_changed', 'The original browser pairing changed. Reopen this interface; unsent work is retained.');
      if (req.method === 'POST' && ['/browser/navigation/poll', '/browser/navigation/receipt'].includes(url.pathname)) {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw deviceError('device_content_type', 'Send JSON.', 415);
        let body; try { body = JSON.parse((await read(req, 32000)).toString('utf8')); } catch (error) { if (error.code) throw error; throw deviceError('device_json', 'Invalid navigation JSON.', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw deviceError('device_json', 'A navigation object is required.', 400);
        const result = url.pathname.endsWith('/poll') ? navigation.poll(device.id, authenticate, body) : navigation.receipt(device.id, authenticate, body);
        authenticate(); json(res, 200, result); return;
      }
      if (req.method === 'GET' && url.pathname === '/browser/session') { json(res, 200, { serverId, device: safeDevice(device) }); return; }
      if (req.method === 'POST' && url.pathname === '/browser/logout') { authority.revoke(device.id); json(res, 200, { revoked: true }, { 'set-cookie': sessionCookie('') }); return; }
      if (readOnly && url.pathname === '/' && !isOwner(device)) {
        send(res, { headers: { 'content-type': 'text/html; charset=utf-8' }, body: webEntryHtml(bundle, { mode: 'draw', deviceId: device.id }) }, req.method); return;
      }
      if (!isOwner(device)) {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') && !readOnly) throw deviceError('device_content_type', 'Send JSON.', 415);
        let body = null;
        if (!readOnly) { try { body = JSON.parse((await read(req)).toString('utf8')); } catch (error) { if (error.code) throw error; throw deviceError('device_json', 'Invalid JSON.', 400); } }
        await drawing(req, res, { credential: token, url, body, respond: json, projectId: String(req.headers['x-context-room-device-project'] || '') }); return;
      }
      const bytes = readOnly ? Buffer.alloc(0) : await read(req);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => FORWARD_HEADERS.has(key)));
      const controller = new AbortController(); res.once('close', () => controller.abort());
      const response = await owner.request({ version: 1, method: req.method, path: url.pathname + url.search, headers, body: bytes.toString('base64') }, {
        authenticate: () => { const live = authenticate(); if (!isOwner(live)) throw deviceError('device_owner_required', 'The original owner permission is required.'); },
        signal: controller.signal, events: /(?:^|\/)api\/runtime-events$/.test(url.pathname),
      });
      let body = Buffer.from(response.body, 'base64');
      if (response.status === 200 && /(?:^|\/)api\/notebooks\/capabilities$/.test(url.pathname)) {
        body = Buffer.from(JSON.stringify({ ...JSON.parse(body), accountId: 'browser:' + device.id }));
      }
      if (response.status === 200 && response.headers['content-type']?.startsWith('text/html') && (url.pathname === '/' || /^\/reviews\/[^/]+\/?$/.test(url.pathname))) {
        body = Buffer.from(body.toString('utf8').replace('<head>', `<head><meta name="context-room-browser-device" content="${device.id}"><script src="/assets/ui/browser-session.js?v=${webAppVersion()}"></script>`));
      }
      authenticate();
      send(res, { status: response.status, headers: { ...response.headers, 'cache-control': 'no-store' }, body }, req.method);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const known = /^(device|notebook)_/.test(error.code || '');
      json(res, known ? error.statusCode || 400 : 500, { code: known ? error.code : 'device_browser_internal', error: known ? error.message : 'The browser connection failed. Locally saved work is retained.' });
    }
  });
  server.maxConnections = 64; server.setTimeout(15_000);
  server.on('checkContinue', (req, res) => json(res, 417, { code: 'device_expectation', error: 'Streaming expectations are unsupported.' }));
  return { server, origin: tls.origin,
    async listen(host) {
      if (!isIP(host) || ['0.0.0.0', '::'].includes(host)) throw deviceError('device_bind_invalid', 'Bind the browser edge to an explicit local IP.', 400);
      await new Promise((resolve, reject) => { const fail = error => { server.off('listening', ready); reject(error); }; const ready = () => { server.off('error', fail); resolve(); }; server.once('error', fail); server.once('listening', ready); server.listen(tls.port, host); });
    },
    close() { if (!server.listening) return Promise.resolve(); server.closeAllConnections(); return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
