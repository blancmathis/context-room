import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NOTEBOOK_WEB_ASSETS } from '../src/notebook_web_assets.mjs';

// Audit the actual modules, including lazily imported drawing/review surfaces.
// A filesystem module existing is insufficient: its browser URL must be served.
test('the explicit browser module graph serves native drawing and both review URL conventions', () => {
  const compatibility = new Map(['local-proposal-review', 'local-draft-editor', 'review-cleanup', 'connected-devices']
    .map(name => ['/assets/' + name + '.mjs', 'ui/' + name + '.mjs']));
  const assets = new Map([...NOTEBOOK_WEB_ASSETS].map(([url, asset]) => [url, asset.file]));
  for (const [url, file] of compatibility) assets.set(url, file);
  assert.equal(assets.get('/assets/ui/local-proposal-review.mjs'), 'ui/local-proposal-review.mjs');
  assert.equal(assets.get('/assets/ui/native-drawing.mjs'), 'ui/native-drawing.mjs');
  for (const [url, file] of assets) {
    const source = fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
    if (!file.endsWith('.mjs')) continue;
    const imports = source.matchAll(/\b(?:import\s*(?:\(|[^'"\n]*?from\s*)|export\s+[^'"\n]*?from\s*)['"]([^'"]+)['"]/g);
    for (const [, reference] of imports) {
      if (!reference.startsWith('.') && !reference.startsWith('/assets/')) continue;
      const target = new URL(reference, 'https://context-room.invalid' + url).pathname;
      assert.ok(assets.has(target), `${url} imports unserved ${target}`);
    }
  }
});
