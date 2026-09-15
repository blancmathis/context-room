import http from 'node:http';
import { deviceError } from './device_authority.mjs';

const MAX_BYTES = 30 * 1024 * 1024;
const HEADERS = new Set(['accept', 'content-type', 'range', 'if-none-match', 'last-event-id',
  'x-context-room-project', 'x-context-room-target-project', 'x-context-room-owner-nonce',
  'x-context-room-prompt-nonce', 'x-context-room-notebook-client']);
const RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'etag', 'content-range',
  'content-security-policy', 'x-content-type-options', 'x-context-room-project', 'x-context-room-target-project', 'x-context-room-version']);

export function ownerRequest(value) {
  if (!value || value.version !== 1 || typeof value.path !== 'string' || value.path.length > 16_384
    || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method)) {
    throw deviceError('device_owner_request', 'Invalid owner request.', 400);
  }
  const rawPath = value.path.split('?')[0];
  let url;
  try { url = new URL(value.path, 'http://context-room.invalid'); }
  catch { throw deviceError('device_owner_route', 'Invalid owner route.', 400); }
  const operationPath = url.pathname.replace(/^\/reviews\/[^/]+(?=\/)/, '');
  if (!value.path.startsWith('/') || value.path.startsWith('//') || /[\\#\x00-\x20]/.test(value.path)
    || rawPath !== url.pathname || /%(?:2e|2f|5c|00)/i.test(rawPath)
    || !(url.pathname === '/' || /^\/(?:api|assets|vendor|reviews)\//.test(url.pathname))
    || /^\/api\/(?:agent(?:\/|$)|devices\/pair(?:-owner)?$)/.test(operationPath)) {
    throw deviceError('device_owner_route', 'This route is unavailable through the owner connection.', 403);
  }
  const headers = {};
  if (value.headers != null && (typeof value.headers !== 'object' || Array.isArray(value.headers))) throw deviceError('device_owner_headers', 'Invalid request headers.', 400);
  for (const [key, data] of Object.entries(value.headers || {})) {
    const name = key.toLowerCase();
    if (!HEADERS.has(name) || Object.hasOwn(headers, name) || typeof data !== 'string' || data.length > 16_384 || /[\r\n\x00]/.test(data)) {
      throw deviceError('device_owner_headers', 'This request header is unavailable.', 400);
    }
    headers[name] = data;
  }
  const encoded = value.body ?? '';
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_BYTES / 3) * 4) throw deviceError('device_body_limit', 'This request is too large.', 413);
  const body = Buffer.from(encoded, 'base64');
  if (body.toString('base64') !== encoded || body.length > MAX_BYTES || ['GET', 'HEAD'].includes(value.method) && body.length) {
    throw deviceError('device_owner_body', 'Invalid request body.', 400);
  }
  return { method: value.method, path: value.path, headers, body, pathname: url.pathname };
}

/** Adapts only the registered owner runtime. It never supplies its review nonce. */
export function createDeviceOwnerBridge() {
  let runtime = null;
  let bufferedBytes = 0;
  let requestBytes = 0;
  const pending = new Set();
  function attach(server) {
    if (runtime && runtime !== server) throw new Error('An owner runtime is already attached.');
    runtime = server;
    server.once('close', () => { if (runtime === server) { runtime = null; close(); } });
  }
  function close() { for (const request of pending) request.destroy(deviceError('device_owner_unavailable', 'The owner connection closed.', 503)); }
  async function request(value, { authenticate, signal, events = false } = {}) {
    const input = ownerRequest(value), address = runtime?.address();
    if (!address || typeof address === 'string' || !['127.0.0.1', '::1'].includes(address.address)) {
      throw deviceError('device_owner_unavailable', 'The local owner interface is unavailable.', 503);
    }
    if (events !== /(?:^|\/)api\/runtime-events$/.test(input.pathname)) throw deviceError('device_owner_stream', 'Use the runtime event transport for this route.', 400);
    if (events && input.method !== 'GET') throw deviceError('device_owner_stream', 'Runtime events are read-only.', 400);
    authenticate();
    if (pending.size >= 24 || requestBytes + input.body.length > 64 * 1024 * 1024) throw deviceError('device_owner_busy', 'The owner connection is busy. Retry this request.', 429);
    const origin = `http://${address.address === '::1' ? '[::1]' : address.address}:${address.port}`;
    return new Promise((resolve, reject) => {
      let complete = false, response, bytes = 0;
      const chunks = [];
      const outgoing = http.request(origin + input.path, { method: input.method, agent: false,
        headers: { ...input.headers, origin, 'sec-fetch-site': 'same-origin', 'accept-encoding': 'identity',
          ...(input.body.length ? { 'content-length': input.body.length } : {}) } });
      pending.add(outgoing);
      requestBytes += input.body.length;
      const abort = () => finish(deviceError('device_owner_cancelled', 'The owner request was cancelled.', 499));
      function finish(error) {
        if (complete) return;
        complete = true; pending.delete(outgoing); requestBytes -= input.body.length; bufferedBytes -= bytes; clearTimeout(deadline); signal?.removeEventListener('abort', abort);
        try {
          if (error) throw error;
          authenticate(); // A revoked/expired device cannot receive a delayed response.
          const headers = {};
          for (const [key, value] of Object.entries(response.headers)) if (RESPONSE_HEADERS.has(key) && typeof value === 'string') headers[key] = value;
          resolve({ version: 1, status: response.statusCode, headers, body: Buffer.concat(chunks).toString('base64'), origin });
        } catch (failure) { reject(failure); }
        response?.destroy(); outgoing.destroy();
      }
      const deadline = setTimeout(() => finish(deviceError('device_owner_timeout', 'The owner operation did not finish in time. Check its state before retrying.', 504)), 10_000);
      signal?.addEventListener('abort', abort, { once: true });
      outgoing.on('error', error => finish(error));
      outgoing.on('response', incoming => {
        response = incoming;
        incoming.on('error', error => finish(error));
        incoming.on('data', chunk => {
          bytes += chunk.length; bufferedBytes += chunk.length;
          if (bufferedBytes > 64 * 1024 * 1024 || bytes > (events ? 2 * 1024 * 1024 : MAX_BYTES)) { finish(deviceError('device_body_limit', 'The owner response is too large or other transfers are busy.', 413)); return; }
          chunks.push(chunk);
          // The existing SSE ready frame follows all replayable events. Read a
          // bounded snapshot and resume at its cursor, without keeping sockets.
          if (events && /\nevent: ready\ndata: [^\n]*\n\n/.test('\n' + Buffer.concat(chunks).toString('utf8'))) finish();
        });
        incoming.on('end', () => finish());
      });
      if (signal?.aborted) { abort(); return; }
      outgoing.end(input.body);
    });
  }
  return { attach, request, close, available: () => Boolean(runtime?.listening) };
}
