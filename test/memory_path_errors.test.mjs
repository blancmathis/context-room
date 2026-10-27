import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeContextRoomProject, resolveMemoryPath } from '../src/context_room.mjs';

test('a file outside the allowed paths is refused with a 403, not an internal error', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-ignored-')));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'CONTEXT-plan.md'), '# plan\n');
  initializeContextRoomProject(root, { allowedPaths: ['docs/'], watchAllow: [] });
  assert.throws(() => resolveMemoryPath(root, 'CONTEXT-plan.md'), error => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'file_path_not_allowed');
    assert.equal(error.expose, true);
    assert.match(error.message, /Path not allowed in context room: CONTEXT-plan\.md/);
    return true;
  });
});
