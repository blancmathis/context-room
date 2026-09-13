import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeContextRoomProject, writeMemoryWebappSettings, reviewLocalDocumentationProposal, createMemoryServer } from '../src/context_room.mjs';
import { readDocumentation, buildDocumentationCorpus } from '../src/documentation.mjs';
import { beginLocalProposal, listLocalProposals } from '../src/local_proposals.mjs';
import { openNotebook, mutateNotebook, readNotebook, undoNotebook, decodeNotebook } from '../src/notebooks.mjs';
import { submitNotebookLocal } from '../src/notebook_workflow.mjs';
const human = { kind: 'human', id: 'synthetic-human' }, agent = { kind: 'agent', id: 'synthetic-agent' };
const canWrite = rel => rel.startsWith('docs/') && rel.endsWith('.crnb');
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-notebook-workflow-'))), root = path.join(temp, 'project'), old = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { old[key] = process.env[key]; process.env[key] = path.join(temp, key); }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  initializeContextRoomProject(root, { allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(temp, { recursive: true, force: true }); });
  const scene = openNotebook(root, { path: 'docs/Sketch.crnb', id: 'synthetic-notebook', title: 'Synthetic sketch', canWrite });
  const request = (operationId, edits) => ({ protocolVersion: 1, resourceId: scene.resourceId, operationId, locationRevision: scene.locator.revision, edits });
  return { root, scene, request };
}
const put = id => ({ id, kind: 'put', expectedRevision: 0, object: { id, type: 'rect', x: 20, y: 20, width: 100, height: 60 } });

test('a notebook is frozen into the existing local proposal engine and only its exact human decision enters the corpus', t => {
  const { root, scene, request } = fixture(t);
  mutateNotebook(root, request('agent-draw', [put('agent-box')]), { actor: agent, canWrite });
  const submission = { protocolVersion: 1, resourceId: scene.resourceId, operationId: 'submit-once', expectedRevision: 1, locationRevision: scene.locator.revision, title: 'Synthetic drawing' };
  const receipt = submitNotebookLocal(root, submission, { actor: human, canWrite });
  assert.equal(receipt.status, 'submitted'); assert.equal(receipt.accepted, false);
  assert.equal(listLocalProposals(root).length, 1);
  assert.equal(submitNotebookLocal(root, submission, { actor: human, canWrite }).replayed, true);
  assert.equal(listLocalProposals(root).length, 1);
  assert.equal(fs.existsSync(path.join(root, 'docs/Sketch.crnb')), false);
  assert.equal(buildDocumentationCorpus(root).documents.some(d => d.path === 'docs/Sketch.crnb'), false);
  mutateNotebook(root, request('human-later', [put('later-box')]), { actor: human, canWrite });
  reviewLocalDocumentationProposal(root, receipt.proposalId, { path: 'docs/Sketch.crnb', decision: 'accepted', expectedRevision: receipt.proposalRevision });
  const accepted = readDocumentation(root, 'docs/Sketch.crnb');
  assert.equal(decodeNotebook(fs.readFileSync(accepted.asset.acceptedFile)).objects.length, 1);
  assert.equal(readNotebook(root, scene.resourceId).document.objects.length, 2);
  mutateNotebook(root, request('still-later', [put('third-box')]), { actor: human, canWrite });
  assert.equal(readNotebook(root, scene.resourceId).document.objects.length, 3);
  assert.throws(() => submitNotebookLocal(root, { ...submission, title: 'Other payload' }, { actor: human, canWrite }), { code: 'notebook_replay_conflict' });
});

test('human undo restores retained agent authorship without accepting or deleting independent changes', t => {
  const { root, scene, request } = fixture(t);
  mutateNotebook(root, request('agent-origin', [put('agent-object')]), { actor: agent, canWrite });
  mutateNotebook(root, request('human-delete', [{ id: 'agent-object', kind: 'delete', expectedRevision: 1 }]), { actor: human, canWrite });
  mutateNotebook(root, request('human-independent', [put('independent')]), { actor: human, canWrite });
  undoNotebook(root, { resourceId: scene.resourceId, operationId: 'human-restore', undoOf: 'human-delete', locationRevision: scene.locator.revision }, { actor: human, canWrite });
  const restored = readNotebook(root, scene.resourceId);
  assert.equal(restored.document.objects.length, 2); assert.equal(restored.accepted, false);
  assert.deepEqual(restored.document.objects.find(o => o.id === 'agent-object').createdBy, agent);
});

test('idempotent preparation resumes an interrupted copy, but never replaces a newer draft', t => {
  const { root } = fixture(t), args = { title: 'Preparation', requestId: 'stable-prepare', allowedPaths: ['docs/'], files: [{ path: 'docs/test.md', content: '# Accepted base\n' }] };
  const first = beginLocalProposal(root, args), again = beginLocalProposal(root, args);
  assert.equal(first.id, again.id); assert.equal(listLocalProposals(root).length, 1);
  fs.unlinkSync(path.join(root, '.context-room/local-proposals/proposals', first.id + '.json'));
  assert.equal(beginLocalProposal(root, args).id, first.id);
  fs.unlinkSync(path.join(root, '.context-room/local-proposals/proposals', first.id + '.json'));
  fs.writeFileSync(path.join(first.editRoot, 'docs/test.md'), '# Newer local work\n');
  assert.throws(() => beginLocalProposal(root, args), { code: 'local_proposal_preparation_conflict' });
  assert.equal(fs.readFileSync(path.join(first.editRoot, 'docs/test.md'), 'utf8'), '# Newer local work\n');
});

test('real HTTP notebook routes enforce existing owner authority, original project and protocol, then deliver a reviewable file', async t => {
  const { root } = fixture(t), room = createMemoryServer({ root });
  await new Promise(resolve => room.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { room.server.closeAllConnections(); room.server.close(resolve); }));
  const base = `http://127.0.0.1:${room.server.address().port}`;
  const post = async (route, body, extra = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-context-room-owner-nonce': room.ownerMutationNonce,
      'x-context-room-project': room.projectId, 'x-context-room-notebook-client': 'synthetic-tablet', ...extra }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const open = { protocolVersion: 1, path: 'docs/Remote.crnb', id: 'remote-notebook', title: 'Remote synthetic sketch' };
  assert.equal((await post('/api/notebooks/open', open, { 'x-context-room-owner-nonce': '' })).status, 403);
  assert.equal((await post('/api/notebooks/open', open, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await post('/api/notebooks/open', { ...open, protocolVersion: 99 })).status, 400);
  assert.equal((await post('/api/notebooks/open', { ...open, path: '../escape.crnb' })).status, 400);
  const opened = await post('/api/notebooks/open', open);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const op = { protocolVersion: 1, resourceId: opened.body.resourceId, operationId: 'http-ink', locationRevision: opened.body.locator.revision, edits: [put('http-shape')] };
  const changed = await post('/api/notebooks/mutate', op); assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal((await post('/api/notebooks/mutate', op)).body.replayed, true);
  const submitted = await post('/api/notebooks/submit', { protocolVersion: 1, resourceId: op.resourceId, operationId: 'http-submit', expectedRevision: 1, locationRevision: op.locationRevision });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body)); assert.equal(submitted.body.accepted, false);
  const file = await (await fetch(base + '/api/docqa/local-proposal-file?proposal=' + submitted.body.proposalId + '&path=docs%2FRemote.crnb')).json();
  assert.equal(decodeNotebook(Buffer.from(file.afterBase64, 'base64')).objects.length, 1);
});
