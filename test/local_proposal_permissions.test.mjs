import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginLocalProposal, submitLocalProposal, decideLocalProposalFile, readAcceptedLocalProposalFile } from '../src/local_proposals.mjs';

for (const mode of [0o600, 0o644, 0o755]) {
  test(`exact reviewed mode ${mode.toString(8)} survives a restrictive umask and a subsequent proposal`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-proposal-mode-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'docs'));
    const target = path.join(root, 'docs/a.md');
    fs.writeFileSync(target, 'accepted original\n');
    // The accepted version explicitly includes its actual filesystem mode.
    // Ambient creation permissions must not manufacture an origin conflict.
    fs.chmodSync(target, mode);
    const previousMask = process.umask(0o077);
    try {
      for (const content of ['first reviewed bytes\n', 'next reviewed bytes\n']) {
        let proposal = beginLocalProposal(root, { title: 'Exact permissions', allowedPaths: ['docs/'],
          files: [{ path: 'docs/a.md', content: fs.readFileSync(target), mode }] });
        fs.writeFileSync(path.join(proposal.editRoot, 'docs/a.md'), content);
        proposal = submitLocalProposal(root, proposal.id);
        assert.equal(proposal.changes[0].before.mode, mode);
        assert.equal(proposal.changes[0].after.mode, mode);
        decideLocalProposalFile(root, proposal.id, { path: 'docs/a.md', decision: 'accepted', expectedRevision: proposal.submittedRevision });
        assert.equal(fs.readFileSync(target, 'utf8'), content);
        assert.equal(fs.statSync(target).mode & 0o777, mode, 'the file must match the exact reviewed mode, not the process umask');
        const accepted = readAcceptedLocalProposalFile(root, 'docs/a.md');
        assert.equal(accepted.mode, mode);
        assert.equal(accepted.bytes.toString(), content);
      }
    } finally { process.umask(previousMask); }
  });
}

test('a concurrent permission-only origin change still refuses acceptance', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-proposal-origin-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  const target = path.join(root, 'docs/a.md');
  fs.writeFileSync(target, 'accepted original\n'); fs.chmodSync(target, 0o644);
  let proposal = beginLocalProposal(root, { title: 'Keep origin authority', allowedPaths: ['docs/'],
    files: [{ path: 'docs/a.md', content: fs.readFileSync(target), mode: 0o644 }] });
  fs.writeFileSync(path.join(proposal.editRoot, 'docs/a.md'), 'proposed\n');
  proposal = submitLocalProposal(root, proposal.id);
  fs.chmodSync(target, 0o600);
  assert.throws(() => decideLocalProposalFile(root, proposal.id, { path: 'docs/a.md', decision: 'accepted', expectedRevision: proposal.submittedRevision }), { code: 'local_proposal_conflict' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'accepted original\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});
