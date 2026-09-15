import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeContextRoomProject, writeMemoryWebappSettings, createMemoryServer, readSharedDocumentAsset, writeSharedProposalFileBatchDecision } from '../src/context_room.mjs';
import { readSharedNotebookTarget, listSharedProposalWorkspaces, materializeSharedReview, connectSharedContext, acceptSharedReview } from '../src/shared_context.mjs';
import { buildDocumentationCorpus } from '../src/documentation.mjs';
import { openNotebook, mutateNotebook, readNotebook, decodeNotebook } from '../src/notebooks.mjs';
import { submitNotebookShared } from '../src/notebook_workflow.mjs';
import { notebookHash } from '../src/notebook_io.mjs';
import { addNotebookSharedFixture, removeNotebookSharedFixture, notebookFixtureGit as git } from './fixtures/notebook_shared.mjs';

const actor = { kind: 'human', id: 'synthetic-owner' };
const canWrite = rel => rel.startsWith('docs/') && rel.endsWith('.crnb');
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.homedir(), '.context-room-notebook-shared-test-'));
  const base = fs.realpathSync(scratch), root = path.join(base, 'project'), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME', 'GIT_CONFIG_GLOBAL']) {
    previous[key] = process.env[key]; process.env[key] = key === 'GIT_CONFIG_GLOBAL' ? '/dev/null' : path.join(scratch, key);
  }
  let runtime = null;
  t.after(async () => {
    if (runtime) { await new Promise(resolve => { runtime.server.closeAllConnections(); runtime.server.close(resolve); }); await runtime.waitForShutdown(); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    removeNotebookSharedFixture(base);
  });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  initializeContextRoomProject(root, { allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  const shared = addNotebookSharedFixture(root, base);
  const scene = openNotebook(root, { path: 'docs/ideas/Sketch.crnb', id: 'shared-notebook', title: 'Synthetic sketch', canWrite });
  const draw = id => mutateNotebook(root, { protocolVersion: 1, resourceId: scene.resourceId, operationId: id, locationRevision: scene.locator.revision,
    edits: [{ kind: 'put', id, expectedRevision: 0, object: { id, type: 'rect', x: 10, y: 10, width: 100, height: 80 } }] }, { actor, canWrite });
  draw('initial-object');
  const target = readSharedNotebookTarget(root, scene.locator.path);
  const request = { protocolVersion: 1, scope: 'shared', target, resourceId: scene.resourceId, operationId: 'first-submission', locationRevision: scene.locator.revision, expectedRevision: 1 };
  return { ...shared, root, base, scene, draw, target, request, setRuntime(value) { runtime = value; }, main: git(shared.remote, ['rev-parse', 'main']) };
}
function rejectFixturePush(remote) {
  const hook = path.join(remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 }); return () => fs.unlinkSync(hook);
}

test('Shared freezes one notebook into an exact existing review without accepting later working ink', t => {
  const f = fixture(t);
  assert.equal(f.target.repositoryPath, 'projects/drawing/docs/ideas/Sketch.crnb');
  const receipt = submitNotebookShared(f.root, f.request, { actor, canWrite });
  assert.equal(receipt.status, 'submitted'); assert.equal(receipt.accepted, false); assert.equal(receipt.scope, 'shared');
  const published = git(f.remote, ['show', `${receipt.proposalRevision}:${f.target.repositoryPath}`]);
  assert.equal(decodeNotebook(Buffer.from(published)).objects.length, 1);
  assert.equal(git(f.remote, ['rev-parse', 'main']), f.main);
  assert.equal(fs.existsSync(path.join(f.root, f.scene.locator.path)), false);
  f.draw('later-object');
  const again = submitNotebookShared(f.root, f.request, { actor, canWrite });
  assert.equal(again.replayed, true); assert.equal(again.proposalRevision, receipt.proposalRevision);
  assert.equal(listSharedProposalWorkspaces(f.root).length, 1);
  const review = materializeSharedReview(f.root, { proposal: receipt.proposalId, expectedHead: receipt.proposalRevision });
  assert.equal(decodeNotebook(fs.readFileSync(path.join(review.reviewRoot, f.target.repositoryPath))).objects.length, 1);
  assert.equal(readNotebook(f.root, f.scene.resourceId).document.objects.length, 2);
  assert.equal(git(f.remote, ['rev-parse', 'main']), f.main);
  assert.throws(() => submitNotebookShared(f.root, { ...f.request, title: 'Different intent' }, { actor, canWrite }), { code: 'notebook_replay_conflict' });
  initializeContextRoomProject(review.reviewRoot, { allowedPaths: ['projects/drawing/'], watchAllow: ['projects/drawing/'] });
  const versions = readSharedDocumentAsset(review.reviewRoot, f.target.repositoryPath);
  const correction = decodeNotebook(Buffer.from(versions.afterBase64, 'base64')); correction.title = 'Exact human correction';
  const correctedBytes = Buffer.from(JSON.stringify(correction) + '\n');
  // Synthetic reviewer on this test-owned bare repository only.
  writeSharedProposalFileBatchDecision(review.reviewRoot, { expectedProposalHead: receipt.proposalRevision, decision: 'accept', files: [f.target.repositoryPath], correction: correctedBytes.toString('base64') });
  assert.equal(git(f.remote, ['rev-parse', 'main']), f.main);
  assert.equal(acceptSharedReview(review.reviewRoot, { message: 'Synthetic human accepted the frozen correction' }).accepted, true);
  const accepted = git(f.remote, ['show', `main:${f.target.repositoryPath}`]);
  assert.equal(decodeNotebook(Buffer.from(accepted)).title, correction.title);
  assert.equal(decodeNotebook(Buffer.from(accepted)).objects.length, 1);
  assert.equal(readNotebook(f.root, f.scene.resourceId).document.objects.length, 2);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', `refs/heads/${receipt.proposalId}`]), '');
  const ordinary = buildDocumentationCorpus(f.root).documents.find(item => item.path.endsWith('/ideas/Sketch.crnb'));
  assert.ok(ordinary?.asset?.acceptedFile);
  assert.equal(decodeNotebook(fs.readFileSync(ordinary.asset.acceptedFile)).title, correction.title);
  assert.equal(submitNotebookShared(f.root, f.request, { actor, canWrite }).proposalRevision, receipt.proposalRevision);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', `refs/heads/${receipt.proposalId}`]), '');
});

test('a delivered Shared snapshot recovers its lost local receipt without another publication', t => {
  const f = fixture(t), rename = fs.renameSync; let interrupted = false;
  fs.renameSync = (from, to) => {
    if (!interrupted && String(to).endsWith('/proposals.json') && fs.readFileSync(from, 'utf8').includes('"receipt"')) {
      interrupted = true; throw Object.assign(new Error('Synthetic receipt persistence failure'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  try { assert.throws(() => submitNotebookShared(f.root, f.request, { actor, canWrite }), /Synthetic receipt persistence failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(interrupted, true);
  const workspace = listSharedProposalWorkspaces(f.root)[0], delivered = git(f.remote, ['rev-parse', workspace.branch]);
  f.draw('after-lost-receipt');
  const recovered = submitNotebookShared(f.root, f.request, { actor, canWrite });
  assert.equal(recovered.replayed, true); assert.equal(recovered.proposalRevision, delivered);
  assert.equal(git(f.remote, ['rev-parse', workspace.branch]), delivered); assert.equal(listSharedProposalWorkspaces(f.root).length, 1);
  assert.equal(readNotebook(f.root, f.scene.resourceId).document.objects.length, 2);
});

test('interrupted Shared publication preserves a newer proposal correction', t => {
  const f = fixture(t), restore = rejectFixturePush(f.remote);
  assert.throws(() => submitNotebookShared(f.root, f.request, { actor, canWrite }), /push|publication|rejected/i);
  restore();
  const workspace = listSharedProposalWorkspaces(f.root)[0], file = path.join(workspace.root, f.target.repositoryPath);
  const correction = decodeNotebook(fs.readFileSync(file)); correction.title = 'Newer human correction';
  const bytes = Buffer.from(JSON.stringify(correction) + '\n'); fs.writeFileSync(file, bytes);
  assert.throws(() => submitNotebookShared(f.root, f.request, { actor, canWrite }), /newer correction/i);
  assert.equal(notebookHash(fs.readFileSync(file)), notebookHash(bytes));
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/proposal/']), '');
  assert.equal(git(f.remote, ['rev-parse', 'main']), f.main);
});

test('a changed exact Shared connection cannot redirect an interrupted notebook submission', t => {
  const f = fixture(t), restore = rejectFixturePush(f.remote);
  assert.throws(() => submitNotebookShared(f.root, f.request, { actor, canWrite })); restore();
  connectSharedContext(f.root, { repository: f.remote, projectId: 'other' });
  assert.throws(() => submitNotebookShared(f.root, f.request, { actor, canWrite }), /original Shared connection changed/);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/proposal/']), '');
  assert.equal(readNotebook(f.root, f.scene.resourceId).document.objects.length, 1);
});

test('resuming against newer accepted main rebases only the exact frozen notebook', t => {
  const f = fixture(t), restore = rejectFixturePush(f.remote);
  assert.throws(() => submitNotebookShared(f.root, f.request, { actor, canWrite })); restore();
  fs.writeFileSync(path.join(f.seed, 'projects/drawing/docs/README.md'), '# Newer accepted context\n');
  git(f.seed, ['add', '.']); git(f.seed, ['commit', '-m', 'Independent accepted change']); git(f.seed, ['push', 'origin', 'main']);
  const currentMain = git(f.remote, ['rev-parse', 'main']);
  f.draw('unsubmitted-later-object');
  const receipt = submitNotebookShared(f.root, f.request, { actor, canWrite });
  assert.equal(receipt.target.baseRevision, currentMain);
  assert.equal(git(f.remote, ['diff', '--name-only', `${currentMain}...${receipt.proposalRevision}`]), f.target.repositoryPath);
  assert.equal(decodeNotebook(Buffer.from(git(f.remote, ['show', `${receipt.proposalRevision}:${f.target.repositoryPath}`]))).objects.length, 1);
  assert.equal(git(f.remote, ['rev-parse', 'main']), currentMain);
});

test('a Shared notebook draft never publishes unrelated edits or follows a replaced destination', t => {
  const f = fixture(t), restore = rejectFixturePush(f.remote);
  assert.throws(() => submitNotebookShared(f.root, f.request, { actor, canWrite })); restore();
  const workspace = listSharedProposalWorkspaces(f.root)[0];
  fs.writeFileSync(path.join(workspace.root, 'projects/drawing/docs/README.md'), '# Unrelated newer edit\n');
  assert.throws(() => submitNotebookShared(f.root, f.request, { actor, canWrite }), /another edit/);
  git(workspace.root, ['restore', 'projects/drawing/docs/README.md']);
  const file = path.join(workspace.root, f.target.repositoryPath), outside = path.join(f.base, 'protected.crnb');
  fs.writeFileSync(outside, '# Must stay unchanged\n'); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  assert.throws(() => submitNotebookShared(f.root, f.request, { actor, canWrite }), /linked|symbolic|scope/i);
  assert.equal(fs.readFileSync(outside, 'utf8'), '# Must stay unchanged\n');
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/proposal/']), '');
});

test('real owner HTTP exposes and submits only the connected Shared destination', async t => {
  const f = fixture(t), room = createMemoryServer({ root: f.root });
  f.setRuntime(room);
  await new Promise(resolve => room.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const cap = await (await fetch(origin + '/api/notebooks/capabilities')).json(); assert.equal(cap.sharedSubmission, true);
  const target = await (await fetch(origin + '/api/notebooks/shared-target?resourceId=' + f.scene.resourceId)).json();
  assert.deepEqual(target.target, f.target);
  const send = body => fetch(origin + '/api/notebooks/submit', { method: 'POST', headers: { 'content-type': 'application/json',
    'x-context-room-owner-nonce': room.ownerMutationNonce, 'x-context-room-project': room.projectId }, body: JSON.stringify(body) });
  const bad = await send({ ...f.request, target: { ...f.target, projectId: 'other' } }); assert.equal(bad.status, 409);
  const response = await send({ ...f.request, operationId: 'http-shared-submission' });
  const receipt = await response.json(); assert.equal(response.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.target.repositoryPath, f.target.repositoryPath); assert.equal(receipt.accepted, false);
  assert.equal(git(f.remote, ['rev-parse', 'main']), f.main);
});
