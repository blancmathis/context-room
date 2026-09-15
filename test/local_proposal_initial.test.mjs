import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginLocalProposal, listLocalProposals, submitLocalProposal, readLocalProposalFile, decideLocalProposalFile, readLocalProposalDraft, writeLocalProposalDraft } from '../src/local_proposals.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-initial-proposal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs')); fs.writeFileSync(path.join(root, 'docs/A.md'), 'Accepted original\n');
  const options = { title: 'Recovered working draft', requestId: 'exact-recovery-request', allowedPaths: ['docs/'],
    files: [{ path: 'docs/A.md', content: 'Accepted original\n', mode: 0o644 }],
    initialFiles: [{ path: 'docs/A.md', content: 'Recovered draft\n' }, { path: 'docs/New.md', content: 'New unsent idea\n', mode: 0o600 }] };
  return { root, options, begin: () => beginLocalProposal(root, options) };
}

test('initial working files stay separate from the accepted base and enter the normal exact review workflow', t => {
  const { root, begin } = fixture(t), proposal = begin();
  assert.equal(proposal.status, 'editing'); assert.notEqual(proposal.initial['docs/A.md'].hash, proposal.base['docs/A.md'].hash);
  assert.equal(Object.hasOwn(proposal.base, 'docs/New.md'), false);
  assert.equal(fs.readFileSync(path.join(root, 'docs/A.md'), 'utf8'), 'Accepted original\n');
  assert.equal(fs.existsSync(path.join(root, 'docs/New.md')), false);
  assert.equal(fs.readFileSync(path.join(proposal.editRoot, 'docs/A.md'), 'utf8'), 'Recovered draft\n');
  assert.equal(fs.statSync(path.join(proposal.editRoot, 'docs/New.md')).mode & 0o777, 0o600);
  const submitted = submitLocalProposal(root, proposal.id), file = readLocalProposalFile(root, proposal.id, 'docs/A.md');
  assert.equal(file.beforeBytes.toString(), 'Accepted original\n'); assert.equal(file.afterBytes.toString(), 'Recovered draft\n');
  decideLocalProposalFile(root, proposal.id, { path: 'docs/A.md', decision: 'accepted', expectedRevision: submitted.submittedRevision });
  assert.equal(fs.readFileSync(path.join(root, 'docs/A.md'), 'utf8'), 'Recovered draft\n');
  assert.equal(fs.existsSync(path.join(root, 'docs/New.md')), false);
});

test('published preparation replays keep later human workspace edits and refuse different imported content', t => {
  const { root, options, begin } = fixture(t), proposal = begin(), target = path.join(proposal.editRoot, 'docs/A.md');
  fs.writeFileSync(target, 'Later owner work\n'); fs.chmodSync(target, 0o600);
  assert.equal(begin().id, proposal.id); assert.equal(fs.readFileSync(target, 'utf8'), 'Later owner work\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600); assert.equal(listLocalProposals(root).length, 1);
  assert.throws(() => beginLocalProposal(root, { ...options, initialFiles: [{ path: 'docs/A.md', content: 'Different source' }] }), { code: 'local_proposal_request_conflict' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'Later owner work\n');
});

test('initial working modes survive a restrictive process umask and interruption recovery', t => {
  const { begin } = fixture(t), previous = process.umask(0o077);
  try {
    const proposal = begin();
    assert.equal(fs.statSync(path.join(proposal.editRoot, 'docs/A.md')).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(proposal.editRoot, 'docs/New.md')).mode & 0o777, 0o600);
    assert.equal(begin().id, proposal.id);
  } finally { process.umask(previous); }
});

test('an interrupted initial write resumes before header publication without replacing different later work', t => {
  for (const externalEdit of [false, true]) {
    const { root, begin } = fixture(t), rename = fs.renameSync; let target;
    fs.renameSync = (from, to, ...rest) => { rename(from, to, ...rest); if (!target && String(to).includes('/workspaces/') && String(to).endsWith('/docs/A.md')) { target = String(to); throw new Error('Interrupted initial workspace write'); } };
    try { assert.throws(begin, /Interrupted initial workspace/); } finally { fs.renameSync = rename; }
    assert.ok(target); assert.equal(listLocalProposals(root).length, 0);
    if (externalEdit) {
      fs.writeFileSync(target, 'Newer retained owner text');
      assert.throws(begin, { code: 'local_proposal_preparation_conflict' }); assert.equal(fs.readFileSync(target, 'utf8'), 'Newer retained owner text');
    } else {
      const proposal = begin(); assert.equal(fs.readFileSync(path.join(proposal.editRoot, 'docs/A.md'), 'utf8'), 'Recovered draft\n');
      assert.equal(listLocalProposals(root).length, 1);
    }
  }
});

test('lost acknowledgement after the proposal header preserves subsequent human work on retry', t => {
  const { root, begin } = fixture(t), rename = fs.renameSync; let header;
  fs.renameSync = (from, to, ...rest) => { rename(from, to, ...rest); if (!header && String(to).includes('/proposals/') && String(to).endsWith('.json')) { header = String(to); throw new Error('Lost preparation acknowledgement'); } };
  try { assert.throws(begin, /Lost preparation acknowledgement/); } finally { fs.renameSync = rename; }
  const saved = JSON.parse(fs.readFileSync(header)), file = path.join(root, saved.workspace, 'docs/A.md');
  fs.writeFileSync(file, 'Later edit after lost reply');
  assert.equal(begin().id, saved.id); assert.equal(fs.readFileSync(file, 'utf8'), 'Later edit after lost reply');
});

test('initial files cannot escape the scope, duplicate paths, use malformed content or omit replay identity', t => {
  const { root, options } = fixture(t);
  for (const initialFiles of [[{ path: '../outside.md', content: 'x' }], [{ path: 'outside.md', content: 'x' }],
    [{ path: 'docs/A.md', content: 'x' }, { path: 'docs/A.md', content: 'y' }], [{ path: 'docs/A.md', content: false }],
    [{ path: 'docs/A.md', content: 'x', mode: 0o4777 }]]) assert.throws(() => beginLocalProposal(root, { ...options, initialFiles }));
  assert.throws(() => beginLocalProposal(root, { ...options, requestId: '' }), /stable preparation request/);
  assert.equal(listLocalProposals(root).length, 0); assert.equal(fs.readFileSync(path.join(root, 'docs/A.md'), 'utf8'), 'Accepted original\n');
});

test('integrated draft editing is read-only until an exact scoped save, then submits the saved version separately', t => {
  const { root, begin } = fixture(t), proposal = begin(), canRead = rel => rel.startsWith('docs/');
  const storedBefore = fs.readdirSync(path.join(root, '.context-room/local-proposals/objects'), { recursive: true });
  const file = readLocalProposalDraft(root, proposal.id, 'docs/A.md', { canRead });
  assert.equal(Buffer.from(file.afterBase64, 'base64').toString(), 'Recovered draft\n');
  assert.deepEqual(fs.readdirSync(path.join(root, '.context-room/local-proposals/objects'), { recursive: true }), storedBefore);
  const saved = writeLocalProposalDraft(root, proposal.id, { path: file.path, content: 'Reviewed by its author\n', expectedRevision: file.revision }, { canWrite: canRead });
  assert.notEqual(saved.revision, file.revision); assert.equal(saved.status, 'editing');
  assert.equal(fs.readFileSync(path.join(root, 'docs/A.md'), 'utf8'), 'Accepted original\n');
  assert.throws(() => writeLocalProposalDraft(root, proposal.id, { path: file.path, content: 'Stale edit', expectedRevision: file.revision }, { canWrite: canRead }), { code: 'local_proposal_stale' });
  assert.throws(() => submitLocalProposal(root, proposal.id, { canWrite: canRead, expectedDraftRevision: file.revision }), { code: 'local_proposal_stale' });
  const submitted = submitLocalProposal(root, proposal.id, { canWrite: canRead, expectedDraftRevision: saved.revision });
  assert.equal(submitted.status, 'submitted'); assert.equal(readLocalProposalFile(root, proposal.id, file.path).afterBytes.toString(), 'Reviewed by its author\n');
  assert.throws(() => writeLocalProposalDraft(root, proposal.id, { path: file.path, content: 'After submission', expectedRevision: saved.revision }, { canWrite: canRead }), { code: 'local_proposal_closed' });
});

test('draft scope, file modes, HTML originals and concurrent human writes remain protected', t => {
  const { root, begin } = fixture(t), proposal = begin(), canRead = rel => rel.startsWith('docs/');
  assert.throws(() => readLocalProposalDraft(root, proposal.id), { code: 'local_proposal_scope' });
  const opened = readLocalProposalDraft(root, proposal.id, 'docs/A.md', { canRead });
  fs.chmodSync(path.join(proposal.editRoot, 'docs/New.md'), 0o644);
  assert.throws(() => writeLocalProposalDraft(root, proposal.id, { path: opened.path, content: 'Other file changed', expectedRevision: opened.revision }, { canWrite: canRead }), { code: 'local_proposal_stale' });
  fs.writeFileSync(path.join(proposal.editRoot, 'docs/Visual.html'), '<h1>Original HTML</h1>');
  const html = readLocalProposalDraft(root, proposal.id, 'docs/Visual.html', { canRead });
  assert.throws(() => writeLocalProposalDraft(root, proposal.id, { path: html.path, content: '<h1>Source edit</h1>', expectedRevision: html.revision }, { canWrite: canRead }), { code: 'local_proposal_scope' });
  const write = fs.writeFileSync; let intercepted = false;
  // Another editor saves while our temporary content is being prepared.
  fs.writeFileSync = (file, data, ...args) => { write(file, data, ...args); if (!intercepted && typeof file === 'number' && String(data) === 'My correction') { intercepted = true; write(path.join(proposal.editRoot, 'docs/A.md'), 'Later human text'); } };
  try { assert.throws(() => writeLocalProposalDraft(root, proposal.id, { path: opened.path, content: 'My correction', expectedRevision: html.revision }, { canWrite: canRead }), { code: 'notebook_write_conflict' }); }
  finally { fs.writeFileSync = write; }
  assert.equal(intercepted, true); assert.equal(fs.readFileSync(path.join(proposal.editRoot, 'docs/A.md'), 'utf8'), 'Later human text');
  assert.equal(fs.readFileSync(path.join(proposal.editRoot, 'docs/Visual.html'), 'utf8'), '<h1>Original HTML</h1>');
});
