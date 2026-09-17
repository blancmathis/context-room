import test from 'node:test';
import assert from 'node:assert/strict';
import { contextRoomWebAssetBundle } from '../src/context_room.mjs';
import { captureWebBuild, WEB_ASSETS, webAppResponse, webAppVersion, versionWebSource } from '../src/web_app.mjs';
import { offlineNotebookRoute } from '../src/ui/notebook-offline.mjs';

test('public offline build is complete, version-coherent and contains no owner authority', () => {
  const bundle = contextRoomWebAssetBundle('synthetic-prompt-secret', 'synthetic-owner-secret');
  const get = path => webAppResponse(new URL(path, 'https://room.example.test'), bundle);
  const worker = get('/service-worker.js').body;
  const paths = JSON.parse(worker.match(/const PRECACHE = (.*);/)[1]);
  assert.equal(new Set(paths).size, paths.length);
  for (const path of paths) {
    const result = get(path);
    if (path.startsWith(bundle.cssPath)) continue;
    assert.equal(result?.status, 200, path); assert.ok(result.body.length > 0, path);
  }
  const offline = get('/offline.html').body;
  assert.doesNotMatch(offline, /synthetic-(?:prompt|owner)-secret|context-room-owner-nonce/);
  assert.match(offline, /web-entry\.mjs\?v=/);
  assert.doesNotMatch(worker, /self\.skipWaiting\s*\(|clients\.claim\s*\(|indexedDB\.deleteDatabase/);
  assert.ok(paths.every(p => !p.startsWith('/api/') && p !== '/' && !p.startsWith('/reviews/')));
  assert.equal(get('/api/notebooks'), null);
  for (const [path, asset] of WEB_ASSETS) {
    if (!asset.type.includes('javascript')) continue;
    const body = String(get(path).body);
    for (const match of body.matchAll(/(?:from\s*|import\s*\(?)(["'])((?:\/assets\/|\.\.?\/)[^"']+)\1/g)) {
      assert.ok(match[2].includes('?v=' + webAppVersion()), path + ' imports ' + match[2]);
    }
  }
  assert.equal(get('/assets/ui/notebook-editor.mjs?v=obsolete').status, 409);
  assert.equal(JSON.parse(get('/manifest.webmanifest').body).display, 'standalone');
  assert.ok(bundle.js.includes('/assets/ui/notebook-editor.mjs?v='));
});

test('versioning is idempotent and leaves non-application URLs alone', () => {
  const source = `import x from './notebook_client.mjs'; import('/assets/ui/notebook-editor.mjs'); const document='/api/file?path=guide.mjs';`;
  assert.equal(versionWebSource(versionWebSource(source)), versionWebSource(source));
  assert.match(versionWebSource(source), /\/api\/file\?path=guide\.mjs/);
});

test('offline reopening is bound to the exact origin, account, resource and captured ordinary project', () => {
  const origin = 'https://room.example.test', project = 'a'.repeat(24);
  const entry = { key: JSON.stringify(['server', 'local-owner', 'browser', 'notebook']), snapshot: { resourceId: 'notebook' }, metadata: { reopen: { version: 1, scopeKey: JSON.stringify([origin, project, '', '']), transport: 'owner', browserDeviceId: '' } } };
  assert.equal(offlineNotebookRoute(entry, origin).projectId, project);
  assert.equal(offlineNotebookRoute(entry, 'https://other.example.test'), null);
  for (const edit of [e => e.key = JSON.stringify(['server', 'review:frozen', 'browser', 'notebook']), e => e.snapshot.resourceId = 'other', e => e.metadata.reopen.scopeKey = JSON.stringify([origin, project, '', '/reviews/frozen']), e => e.metadata.reopen.browserDeviceId = 'token', e => e.metadata.reopen.capabilities = { protocolVersion: 1, serverId: 'other', accountId: 'local-owner' }]) {
    const changed = structuredClone(entry); edit(changed); assert.equal(offlineNotebookRoute(changed, origin), null);
  }
});

// Original authority metadata is a recovery hint, never a new authentication credential.
test('saved recovery capabilities remain bound to their original account after another pairing', () => {
  const origin = 'https://room.example.test', project = 'a'.repeat(24);
  const entry = { key: JSON.stringify(['server', 'browser:original-pairing', 'device', 'notebook']), snapshot: { resourceId: 'notebook' },
    metadata: { reopen: { version: 1, scopeKey: JSON.stringify([origin, project, '', '']), transport: 'owner',
      capabilities: { protocolVersion: 1, serverId: 'server', accountId: 'browser:original-pairing' } } } };
  assert.equal(offlineNotebookRoute(entry, origin).accountId, 'browser:original-pairing');
  entry.metadata.reopen.capabilities.accountId = 'browser:replacement-pairing';
  assert.equal(offlineNotebookRoute(entry, origin), null);
});

test('a running public cohort cannot change after its on-disk source is replaced', () => {
  const disk = new Map([['editor.mjs', Buffer.from('original editor')], ['canvas.mjs', Buffer.from('original canvas')]]);
  const original = captureWebBuild([...disk.keys()], file => disk.get(file));
  disk.get('editor.mjs').fill(120); disk.set('canvas.mjs', Buffer.from('replacement canvas'));
  assert.equal(original.bytes.get('editor.mjs').toString(), 'original editor');
  assert.equal(original.bytes.get('canvas.mjs').toString(), 'original canvas');
  assert.notEqual(captureWebBuild([...disk.keys()], file => disk.get(file)).version, original.version);
});

test('APK packaging copies the same complete public web cohort without authority or a Java tool copy', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { prepareAndroidWeb } = await import('../scripts/prepare-android-web.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shared-apk-web-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packaged = prepareAndroidWeb(directory), index = JSON.parse(fs.readFileSync(path.join(directory, 'web/index.json')));
  assert.equal(packaged.version, webAppVersion()); assert.equal(index.version, webAppVersion());
  const bundle = contextRoomWebAssetBundle();
  for (const url of [...WEB_ASSETS.keys(), '/manifest.webmanifest', '/offline.html']) {
    const entry = index.files[url]; assert.ok(entry, url);
    assert.deepEqual(fs.readFileSync(path.join(directory, entry.asset)), Buffer.from(webAppResponse(new URL(url, 'https://packaged.example.test'), bundle).body));
  }
  assert.equal(index.files['/api/notebooks'], undefined);
  const offline = fs.readFileSync(path.join(directory, 'web/offline.html'), 'utf8');
  assert.match(offline, /web-entry.mjs/); assert.doesNotMatch(offline, /owner-nonce|prompt-nonce/);
  assert.ok(index.files['/assets/ui/notebook-editor.mjs?v=' + webAppVersion()]);
  assert.ok(index.files['/assets/ui/notebook-canvas.mjs?v=' + webAppVersion()]);
});

test('offline-ready status follows actual activation and fails explicitly for incomplete or stalled caching', async () => {
  const { waitForApplicationCache } = await import('../src/ui/web-app.mjs');
  const registration = new EventTarget(), worker = new EventTarget();
  worker.state = 'installing'; registration.installing = worker;
  const ready = waitForApplicationCache(registration, 1000);
  worker.state = 'activated'; registration.active = worker; registration.installing = null; worker.dispatchEvent(new Event('statechange'));
  assert.equal(await ready, registration);
  assert.equal(await waitForApplicationCache(registration, 1000), registration);
  registration.active = null; registration.installing = worker; worker.state = 'installing';
  const failed = assert.rejects(waitForApplicationCache(registration, 1000), /caching failed/);
  worker.state = 'redundant'; registration.installing = null; worker.dispatchEvent(new Event('statechange')); await failed;
  await assert.rejects(waitForApplicationCache(new EventTarget(), 5), /not confirmed/);
});

test('existing content-hashed shell URLs retain their HTTP cache and diagnostic contract', () => {
  const source = '<link href="/assets/context-room.0123456789abcdef.css"><script src="/assets/context-room.fedcba9876543210.js"></script>';
  assert.equal(versionWebSource(source), source);
  const bundle = contextRoomWebAssetBundle();
  const worker = webAppResponse(new URL('/service-worker.js', 'https://room.example.test'), bundle).body;
  assert.ok(JSON.parse(worker.match(/const PRECACHE = (.*);/)[1]).includes(bundle.cssPath));
});
