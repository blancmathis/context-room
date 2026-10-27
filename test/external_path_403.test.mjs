import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeContextRoomProject, readFileDiff, readMemoryFile, revertMemoryFile } from '../src/context_room.mjs';

const EXTERNAL = '~/elsewhere/guide.md';

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-external-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  initializeContextRoomProject(root, { allowedPaths: ['docs/'], watchAllow: [] });
  return root;
}

function assertNotAllowed(error) {
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'file_path_not_allowed');
  assert.equal(error.expose, true);
  assert.match(error.message, /Path not allowed in context room: ~\/elsewhere\/guide\.md/);
  return true;
}

test('reading a forbidden external path is a 403, not an internal error', (t) => {
  assert.throws(() => readMemoryFile(project(t), EXTERNAL), assertNotAllowed);
});

test('the diff of a forbidden external path is a 403', (t) => {
  assert.throws(() => readFileDiff(project(t), EXTERNAL), assertNotAllowed);
});

test('reverting a forbidden external path is a 403', (t) => {
  assert.throws(() => revertMemoryFile(project(t), EXTERNAL), assertNotAllowed);
});
