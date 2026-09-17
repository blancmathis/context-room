#!/usr/bin/env node
/** Build output only: package the very same web editor, never a native UI fork. */
import fs from 'node:fs';
import path from 'node:path';
import { contextRoomWebAssetBundle } from '../src/context_room.mjs';
import { WEB_ASSETS, webAppResponse, webAppVersion, webEntryHtml } from '../src/web_app.mjs';

export function prepareAndroidWeb(output) {
  if (!output || !path.isAbsolute(output)) throw new TypeError('An explicit absolute generated-assets directory is required.');
  const bundle = contextRoomWebAssetBundle(), version = webAppVersion(), files = {};
  const put = (url, type, body) => {
    const asset = 'web' + url;
    fs.mkdirSync(path.dirname(path.join(output, asset)), { recursive: true }); fs.writeFileSync(path.join(output, asset), body);
    files[url] = { asset, type }; files[url + '?v=' + version] = files[url];
  };
  for (const url of [...WEB_ASSETS.keys(), '/manifest.webmanifest', '/offline.html']) {
    const result = webAppResponse(new URL(url, 'https://packaged.example.test'), bundle);
    if (!result || result.status !== 200) throw new Error('Incomplete common web build: ' + url);
    put(url, result.headers['content-type'].split(';')[0], result.body);
  }
  put(bundle.cssPath, 'text/css', bundle.css); put(bundle.jsPath, 'text/javascript', bundle.js);
  put('/draw.html', 'text/html', webEntryHtml(bundle, { mode: 'draw' }));
  fs.writeFileSync(path.join(output, 'web/index.json'), JSON.stringify({ version, files }));
  return { version, paths: Object.keys(files).length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(prepareAndroidWeb(process.argv[2])));
}
