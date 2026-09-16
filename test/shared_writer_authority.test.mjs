import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeContextRoomProject } from '../src/context_room.mjs';
import { createSharedProposal, ensureSharedProposal, publishSharedProposal, publishSharedRepositoryProposal, publishSharedNotebookSnapshot, listSharedProposalWorkspaces } from '../src/shared_context.mjs';
import { registerContextHubSharedRepository } from '../src/context_hub.mjs';
import { canonicalNotebookRoot, writeNotebookJson } from '../src/notebook_io.mjs';
import { WRITER_AUTHORITY } from '../src/writer_authority.mjs';
import { addNotebookSharedFixture, removeNotebookSharedFixture, notebookFixtureGit as git } from './fixtures/notebook_shared.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.cr-shared-writer-test-'))), root = path.join(base, 'project'), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME', 'GIT_CONFIG_GLOBAL']) {
    previous[key] = process.env[key]; process.env[key] = key === 'GIT_CONFIG_GLOBAL' ? '/dev/null' : path.join(base, key);
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } removeNotebookSharedFixture(base); });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  initializeContextRoomProject(root, { allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  const shared = addNotebookSharedFixture(root, base); registerContextHubSharedRepository(shared.remote);
  const proposal = createSharedProposal(root, { title: 'Retained synthetic update', description: 'Original update for human review', sessionId: 'synthetic-writer' });
  const file = path.join(proposal.root, 'projects/drawing/docs/README.md'); fs.writeFileSync(file, '# Later human working content\n');
  const pause = () => writeNotebookJson(root, WRITER_AUTHORITY, { version: 1, rootIdentity: canonicalNotebookRoot(root), migrationId: 'a'.repeat(64), generation: 1, mode: 'paused' });
  return { ...shared, root, proposal, file, pause, main: git(shared.remote, ['rev-parse', 'main']), head: git(proposal.root, ['rev-parse', 'HEAD']) };
}

test('paused project creation, reuse and publication refuse through APIs and the real CLI without losing newer Shared working bytes', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file); f.pause();
  for (const work of [
    () => createSharedProposal(f.root, { title: 'Must not create' }),
    () => ensureSharedProposal(f.root, { title: 'Must not reuse', sessionId: 'synthetic-writer' }),
    () => publishSharedProposal(f.root, { proposal: f.proposal.branch }),
    () => publishSharedRepositoryProposal(f.remote, { proposal: f.proposal.branch }),
    () => publishSharedNotebookSnapshot(f.root, {}),
  ]) assert.throws(work, { code: 'migration_writer_paused' });
  const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [cli, 'shared', 'publish', '--root', f.root, '--proposal', f.proposal.branch], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 }), /migration has paused writing/);
  assert.equal(listSharedProposalWorkspaces(f.root).length, 1);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.equal(git(f.proposal.root, ['rev-parse', 'HEAD']), f.head);
  assert.equal(git(f.remote, ['rev-parse', 'main']), f.main);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/proposal/', 'refs/heads/context-room-state/']), '');
});

test('a pause after exact Shared preparation prevents the remote push while retaining the prepared local commit', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file); let prepared = null;
  assert.throws(() => publishSharedProposal(f.root, { proposal: f.proposal.branch, author: { name: 'Synthetic reviewer', email: 'reviewer@example.test' }, verifyBeforePublish: ({ head }) => { prepared = head; f.pause(); } }), { code: 'migration_writer_paused' });
  assert.match(prepared, /^[a-f0-9]{40}$/);
  assert.notEqual(prepared, f.head); assert.equal(git(f.proposal.root, ['rev-parse', 'HEAD']), prepared);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.equal(git(f.remote, ['rev-parse', 'main']), f.main);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/proposal/', 'refs/heads/context-room-state/']), '');
  assert.equal(listSharedProposalWorkspaces(f.root)[0].lastPublishedHead || '', '');
});
