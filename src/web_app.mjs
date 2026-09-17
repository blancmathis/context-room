/** Public, version-coherent application bytes. Never cache an authenticated page. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { NOTEBOOK_WEB_ASSETS } from './notebook_web_assets.mjs';

const aliases = ['local-proposal-review', 'local-draft-editor', 'review-cleanup', 'connected-devices'];
export const WEB_ASSETS = new Map([...NOTEBOOK_WEB_ASSETS,
  ...aliases.map(name => ['/assets/' + name + '.mjs', { file: 'ui/' + name + '.mjs', type: 'text/javascript; charset=utf-8' }]),
  ...[192, 512].map(size => ['/assets/icons/context-room-' + size + '.png', { file: 'ui/icons/context-room-' + size + '.png', type: 'image/png' }]),
]);
/** Capture the public bytes once; an in-place update cannot relabel new bytes
 * with the content version used by an already-running process. Restart into a
 * new immutable checkout to publish another build. */
export function captureWebBuild(files, read = file => fs.readFileSync(new URL('./' + file, import.meta.url))) {
  const bytes = new Map([...new Set(files)].sort().map(file => [file, Buffer.from(read(file))]));
  const version = createHash('sha256').update([...bytes].map(([file, body]) => file + '\0' + body.toString('base64')).join('\0')).digest('hex').slice(0, 24);
  return { version, bytes };
}
let build;
function currentWebBuild() {
  return build ||= captureWebBuild(['ui/app.mjs', 'web_app.mjs', 'ui/service-worker.js', ...[...WEB_ASSETS.values()].map(a => a.file)]);
}
export function webAppVersion() { return currentWebBuild().version; }
function publicSource(file) {
  const bytes = currentWebBuild().bytes.get(file);
  if (!bytes) throw new TypeError('Unknown public web asset.');
  return bytes;
}
export function versionWebSource(source) {
  // Every lazy module and its transitive imports belong to the same build.
  // Old open clients can load their own cohort from the worker after a Mac update.
  return source.replace(/(["'])((?:\/assets\/|\.\.?\/)[^"'\s?]+\.(?:mjs|css|js))\1/g,
    (match, quote, asset) => quote + asset + '?v=' + webAppVersion() + quote);
}
export function webEntryHtml(bundle, { mode = 'offline', deviceId = '' } = {}) {
  if (!['offline', 'pair', 'draw'].includes(mode) || deviceId && !/^[a-f0-9-]{36}$/.test(deviceId)) throw new TypeError('Invalid browser entry.');
  return versionWebSource(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="context-room-web-entry" content="${mode}"><meta name="context-room-browser-device" content="${deviceId}">
<meta name="theme-color" content="#101416"><title>Context Room</title>
<link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="${bundle.cssPath}">
<link rel="stylesheet" href="/assets/ui/web-app.css"><script src="/assets/ui/browser-session.js"></script></head>
<body><main class="web-entry"><h1>Context Room</h1><p id="web-entry-status" role="status"></p>
<div id="web-entry-actions"></div><div id="web-entry-content"></div>
<p>Working ink is saved on this device. The connected Mac owns canonical data and human review.</p>
<button type="button" data-web-app-settings>Install / offline notebooks</button>
</main><script type="module" src="/assets/ui/web-entry.mjs"></script></body></html>`);
}
export function publicWebPaths(bundle) {
  return new Set([...WEB_ASSETS.keys(), bundle.cssPath, bundle.jsPath, '/manifest.webmanifest', '/service-worker.js', '/offline.html']);
}
export function webAppResponse(url, bundle) {
  const headers = { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
  const v = url.searchParams.get('v');
  if (v && v !== webAppVersion() && publicWebPaths(bundle).has(url.pathname)) return { status: 409, headers, body: 'This application build is no longer on the Mac. Close old windows to update; local ink is retained.' };
  const asset = WEB_ASSETS.get(url.pathname);
  if (asset) {
    let body = publicSource(asset.file);
    if (/javascript/.test(asset.type)) body = versionWebSource(body.toString('utf8'));
    return { status: 200, headers: { ...headers, 'content-type': asset.type }, body };
  }
  if (url.pathname === '/manifest.webmanifest') return { status: 200, headers: { ...headers, 'content-type': 'application/manifest+json' }, body: JSON.stringify({
    id: '/', name: 'Context Room', short_name: 'Context Room', start_url: '/', scope: '/', display: 'standalone',
    background_color: '#101416', theme_color: '#101416', lang: 'en',
    icons: [192, 512].map(size => ({ src: `/assets/icons/context-room-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' })),
  }) };
  if (url.pathname === '/offline.html') return { status: 200, headers: { ...headers, 'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }, body: webEntryHtml(bundle) };
  if (url.pathname === '/service-worker.js') {
    const paths = [...WEB_ASSETS.keys()].map(p => /\.(?:mjs|css|js)$/.test(p) ? p + '?v=' + webAppVersion() : p);
    paths.push(bundle.cssPath + '?v=' + webAppVersion(), '/offline.html', '/manifest.webmanifest');
    const source = publicSource('ui/service-worker.js').toString('utf8');
    return { status: 200, headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8', 'service-worker-allowed': '/' },
      body: 'const BUILD = ' + JSON.stringify(webAppVersion()) + ';\nconst PRECACHE = ' + JSON.stringify(paths) + ';\n' + source };
  }
  return null;
}
