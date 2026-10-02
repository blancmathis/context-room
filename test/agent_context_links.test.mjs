import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncContextRoomAgentContext } from '../src/context_room.mjs';

function assertClosedLinks(files) {
  for (const file of files.filter(file => file.endsWith('.md'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, destination] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|mailto:|#)/.test(destination)) continue;
      const target = path.resolve(path.dirname(file), destination.split('#', 1)[0]);
      assert.ok(fs.existsSync(target), `${file} has a broken generated link to ${destination}`);
    }
  }
}

test('installed canonical device docs form a closed link graph without importing lifecycle records', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-agent-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generated = syncContextRoomAgentContext(root);
  const devicePath = path.join(root, '.context-room/agent-context/system/connected-devices.md');
  const canonical = fs.readFileSync(new URL('../docs/system/connected-devices.md', import.meta.url), 'utf8');
  assert.equal(fs.readFileSync(devicePath, 'utf8'), canonical);
  assertClosedLinks(generated.files);
  assert.ok(canonical.includes('`docs/lifecycle/changes/active/android-convergence/codex-shared-web-handoff.md`'));
  assert.equal(fs.existsSync(path.join(root, '.context-room/agent-context/lifecycle')), false);
  assert.equal(syncContextRoomAgentContext(root).updated, 0);
});

test('refresh repairs the old broken device-doc copy without changing other canonical copies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-agent-refresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generated = syncContextRoomAgentContext(root);
  const devicePath = path.join(root, '.context-room/agent-context/system/connected-devices.md');
  const before = new Map(generated.files.map(file => [file, fs.readFileSync(file)]));
  fs.appendFileSync(devicePath, '\n[Old handoff](../lifecycle/changes/active/android-convergence/codex-shared-web-handoff.md)\n');
  assert.throws(() => assertClosedLinks(generated.files), /broken generated link/);
  const refreshed = syncContextRoomAgentContext(root);
  assert.equal(refreshed.updated, 1);
  assert.deepEqual(refreshed.files, generated.files);
  for (const [file, content] of before) assert.deepEqual(fs.readFileSync(file), content);
  assertClosedLinks(refreshed.files);
  assert.equal(syncContextRoomAgentContext(root).updated, 0);
});
