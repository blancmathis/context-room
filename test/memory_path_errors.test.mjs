import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeContextRoomProject, resolveMemoryPath, readFileDiff, readMemoryFile, revertMemoryFile } from '../src/context_room.mjs';

function ignoredRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-ignored-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'CONTEXT-plan.md'), '# plan\n');
  initializeContextRoomProject(root, { allowedPaths: ['docs/'], watchAllow: [] });
  return root;
}

function assertNotAllowed(error) {
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'file_path_not_allowed');
  assert.equal(error.expose, true);
  assert.match(error.message, /Path not allowed in context room: CONTEXT-plan\.md/);
  return true;
}

test('a file outside the allowed paths is refused with a 403, not an internal error', (t) => {
  const root = ignoredRoot(t);
  assert.throws(() => resolveMemoryPath(root, 'CONTEXT-plan.md'), assertNotAllowed);
});

test('an ignored file that opens has no diff instead of a 403', (t) => {
  const root = ignoredRoot(t);
  assert.equal(readMemoryFile(root, 'CONTEXT-plan.md').content, '# plan\n');
  const diff = readFileDiff(root, 'CONTEXT-plan.md');
  assert.equal(diff.available, false);
  assert.equal(diff.changed, false);
});

test('reverting a file outside the allowed paths is refused with the same 403', (t) => {
  const root = ignoredRoot(t);
  assert.throws(() => revertMemoryFile(root, 'CONTEXT-plan.md'), assertNotAllowed);
});
