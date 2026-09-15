import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assistantFixture } from './fixtures/assistant.mjs';
import { legacyConversationSnapshot } from './fixtures/lisiere-conversations.mjs';
import { migrateLisiereConversation, writeMemoryWebappSettings } from '../src/context_room.mjs';
import { openNotebook, readNotebook } from '../src/notebooks.mjs';

test('owner history export verifies every bounded chunk and revocation blocks the next chunk', async () => {
  const f = await assistantFixture();
  try {
    const legacy = await legacyConversationSnapshot(f.base, { longText: 'X'.repeat(600000) }), storageRoot = path.join(f.base, 'private-assistant');
    const options = { snapshot: legacy.snapshot, selector: legacy.selector, path: 'docs/Original.md' }, authority = { storageRoot };
    const preview = migrateLisiereConversation(f.root, options, authority), imported = migrateLisiereConversation(f.root, { ...options, apply: true, expectedRevision: preview.revision }, authority);
    const binding = JSON.parse(fs.readFileSync(path.join(storageRoot, 'conversations', imported.conversationId + '.json'))), route = f.url + '/api/assistant/conversations/' + imported.conversationId + '/legacy-history';
    const parts = []; let offset = 0, expectedHash;
    while (offset !== null) {
      const response = await fetch(route + '?download=1&offset=' + offset); assert.equal(response.status, 200); const part = await response.json();
      expectedHash ||= part.sha256; assert.equal(part.sha256, expectedHash); assert.equal(part.offset, offset);
      const bytes = Buffer.from(part.data, 'base64'); assert.ok(bytes.length <= 1024 * 1024); parts.push(bytes); offset = part.nextOffset;
    }
    assert.ok(parts.length > 1); const file = path.join(storageRoot, 'legacy-history', binding.legacy.hash + '.json');
    assert.equal(Buffer.concat(parts).equals(fs.readFileSync(file)), true);
    assert.equal((await fetch(route + '?download=1&offset=-1')).status, 400);
    const forged = await f.post('/api/assistant/conversations', { source: { kind: 'document', path: 'docs/Original.md' }, legacy: binding.legacy });
    assert.equal(forged.status, 201); assert.equal(forged.body.legacy, null);
    const first = await (await fetch(route + '?download=1')).json(); assert.notEqual(first.nextOffset, null);
    writeMemoryWebappSettings(f.root, { allowedPaths: ['docs/Other.md'] });
    assert.equal((await fetch(route + '?download=1&offset=' + first.nextOffset)).status, 403); assert.equal(f.connections(), 0);
  } finally { await f.close(); }
});

test('the CLI links a working notebook without accepting it or starting an original task', async () => {
  const f = await assistantFixture();
  try {
    const legacy = await legacyConversationSnapshot(f.base), storageRoot = path.join(f.base, 'private-assistant');
    const scene = openNotebook(f.root, { path: 'docs/Sketch.crnb', canWrite: () => true });
    const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
    const args = [cli, 'migrate', '--root', f.root, '--import-lisiere', legacy.snapshot, '--legacy-conversation', legacy.selector, '--path', 'docs/Sketch.crnb'];
    const environment = { cwd: f.base, encoding: 'utf8', timeout: 30000, env: { ...process.env, CONTEXT_ROOM_ASSISTANT_HOME: storageRoot } };
    const preview = JSON.parse(execFileSync(process.execPath, args, environment)).data; assert.equal(fs.existsSync(storageRoot), false);
    const applied = JSON.parse(execFileSync(process.execPath, [...args, '--apply', '--revision', preview.revision], environment)).data;
    assert.equal(applied.accepted, false); assert.equal(applied.threadId, null); assert.equal(fs.existsSync(path.join(f.root, 'docs/Sketch.crnb')), false);
    assert.deepEqual(readNotebook(f.root, scene.resourceId).document, scene.document);
    const binding = JSON.parse(fs.readFileSync(path.join(storageRoot, 'conversations', applied.conversationId + '.json')));
    assert.equal(binding.origin.source.resourceId, scene.resourceId); assert.equal(binding.origin.source.locationRevision, scene.locator.revision);
    assert.throws(() => execFileSync(process.execPath, [...args, '--legacy-draft', legacy.selector], { ...environment, stdio: 'pipe' }), error => {
      assert.equal(JSON.parse(error.stderr).error.code, 'invalid-arguments'); return true;
    });
    assert.equal(f.connections(), 0);
  } finally { await f.close(); }
});
