import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initializeContextRoomProject, resolveMemoryPath, readFileDiff, readMemoryFile, revertMemoryFile, createMemoryServer } from '../src/context_room.mjs';

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

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' });
}

function gitIgnoredRoot(t) {
  const root = ignoredRoot(t);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

test('an ignored file inside a Git repository has no diff instead of a 403', (t) => {
  const root = gitIgnoredRoot(t);
  fs.writeFileSync(path.join(root, 'CONTEXT-plan.md'), '# plan changed\n');
  assert.equal(readMemoryFile(root, 'CONTEXT-plan.md').content, '# plan changed\n');
  const diff = readFileDiff(root, 'CONTEXT-plan.md');
  assert.equal(diff.available, false);
  assert.equal(diff.changed, false);
});

test('the HTTP file and diff endpoints both answer 200 for an ignored file, with no error', async (t) => {
  const root = gitIgnoredRoot(t);
  const { server } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const query = '?path=' + encodeURIComponent('CONTEXT-plan.md');
  const file = await fetch(baseUrl + '/api/file' + query);
  assert.equal(file.status, 200);
  assert.equal((await file.json()).content, '# plan\n');
  const diffResponse = await fetch(baseUrl + '/api/file/diff' + query);
  assert.equal(diffResponse.status, 200);
  const diff = await diffResponse.json();
  assert.equal(diff.error, undefined);
  assert.equal(diff.available, false);
  assert.equal(diff.changed, false);
});

test('reverting a cron job path while the Hermes integration is off is refused with a 403', (t) => {
  const root = ignoredRoot(t);
  assert.throws(() => revertMemoryFile(root, '~/.hermes/cron/jobs/abc.json', { expectedRevision: 'x' }), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'file_path_not_allowed');
    return true;
  });
});

test('reverting a rename whose old path is not allowed is refused with a 403', (t) => {
  const root = ignoredRoot(t);
  fs.mkdirSync(path.join(root, 'other'));
  fs.writeFileSync(path.join(root, 'other', 'a.md'), '# a\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'mv', 'other/a.md', 'docs/a.md');
  const { revision } = readFileDiff(root, 'docs/a.md');
  assert.throws(() => revertMemoryFile(root, 'docs/a.md', { expectedRevision: revision }), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'file_path_not_allowed');
    assert.match(error.message, /Path not allowed in context room: other\/a\.md/);
    return true;
  });
});
