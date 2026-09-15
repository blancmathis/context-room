import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tabletDraftSnapshot } from './fixtures/lisiere-tablet-drafts.mjs';
import { migrateLisiereDocument } from '../src/lisiere_documents.mjs';
import { readLisiereSnapshot } from '../src/lisiere_archive.mjs';
import { inspectLisiereSnapshot } from '../src/lisiere_inventory.mjs';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';
import { listLocalProposals } from '../src/local_proposals.mjs';
import { initializeContextRoomProject } from '../src/context_room.mjs';
import { notebookHash } from '../src/notebook_io.mjs';

async function fixture(t, settings) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-tablet-draft-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const retained = await tabletDraftSnapshot(base, settings), root = path.join(base, 'project'); fs.mkdirSync(root);
  const options = { snapshot: retained.snapshot, selector: retained.selector, path: 'docs/Recovered.md' };
  const authority = { canWrite: name => name.startsWith('docs/'), acceptedBase: () => null };
  const plan = () => migrateLisiereDocument(root, options, authority);
  const apply = revision => migrateLisiereDocument(root, { ...options, apply: true, expectedRevision: revision }, authority);
  return { ...retained, base, root, options, authority, plan, apply };
}

test('tablet seed and binary UTF-16 deltas become an exact working draft without sending or accepting pending work', async t => {
  const f = await fixture(t, { change(cache, { key }) {
    cache.set(`draftmerge:${key}`, JSON.stringify({ id: 'original-proposal', contentSha256: 'a'.repeat(64) }));
    cache.set(`draftmerge-backup:${key}`, 'Earlier retained tablet text');
  } });
  const database = fs.readFileSync(path.join(f.source, 'workspace.sqlite')), plan = f.plan();
  assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(plan.source.kind, 'android-workspace');
  assert.equal(plan.source.version, 107); assert.equal(plan.source.acknowledgedVersion, 101);
  assert.equal(plan.source.pending, true); assert.equal(plan.source.delivery, 'not-inferred');
  assert.equal(plan.source.device, null); assert.equal(plan.source.pendingReconciliation, true);
  const imported = f.apply(plan.revision), raw = fs.readFileSync(path.join(f.root, imported.recovery, 'source-draft.json'));
  const original = JSON.parse(raw), archive = readLisiereSnapshot(f.snapshot), rows = new Map([...archive.rows('cache')].map(row => [row.key, row.value]));
  assert.equal(imported.status, 'editing'); assert.equal(imported.accepted, false);
  assert.equal(fs.existsSync(path.join(f.root, f.options.path)), false);
  assert.equal(fs.readFileSync(path.join(imported.editRoot, f.options.path), 'utf8'), f.content);
  assert.equal(original.reconstructed.content, f.content); assert.equal(original.reconstructed.consumedDeltas.length, 2);
  for (const row of original.records) {
    if (row.value?.base64) assert.deepEqual(Buffer.from(row.value.base64, 'base64'), rows.get(row.key));
    else assert.deepEqual(row.value, rows.get(row.key));
  }
  assert.equal(raw.includes('Unrelated synthetic'), false); assert.equal(raw.includes('native-request'), false);
  assert.equal(original.records.some(row => row.key === `draftmerge-backup:${f.key}`), true);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'workspace.sqlite')), database);
  assert.equal([...readLisiereSnapshot(f.snapshot).rows('outbox')].length, 1);
  assert.equal(fs.statSync(path.join(f.root, imported.recovery, 'source-draft.json')).mode & 0o777, 0o600);
});

test('earlier pending tablet text keeps its unknown receipt while a seed alone cannot import', async t => {
  const f = await fixture(t, { legacy: true }), plan = f.plan();
  assert.equal(plan.source.epoch, null); assert.equal(plan.source.acknowledgedVersion, null);
  assert.equal(fs.readFileSync(path.join(f.apply(plan.revision).editRoot, f.options.path), 'utf8'), f.content);
  f.options.selector = inspectLisiereSnapshot(f.snapshot, { kind: 'drafts' }).items.find(item => item.sourceKey === `draftdoc:${f.key}`).selector;
  assert.throws(f.plan, /text seed alone/);
});

test('incomplete journals, newer epochs, conflicting earlier seeds and unfinished composition stop before any import', async t => {
  const cases = [
    [false, (cache, { epoch }) => cache.delete(`draftdelta:${epoch}:${'107'.padStart(20, '0')}`), /latest.*delta.*missing/],
    [false, (cache, { key, meta }) => cache.set(`draftmeta:${key}`, JSON.stringify({ ...meta, epoch: 'newer-epoch' })), /latest.*delta.*missing/],
    [true, (cache, { key }) => cache.set(`draftdoc:${key}`, 'A divergent retained seed'), /disagree/],
    [true, (cache, { key }) => cache.set(`draftmeta:${key}`, '{}'), /newer tablet journal/],
    [false, (cache, { key, epoch, meta, seed }) => {
      cache.set(`draftdelta:${epoch}:${'107'.padStart(20, '0')}`, { binary: { start: seed.length, removed: 0, inserted: '\ud83d' } });
      cache.set(`draftmeta:${key}`, JSON.stringify({ ...meta, length: seed.length + 1 }));
    }, /unfinished UTF-16/],
  ];
  for (const [legacy, change, error] of cases) {
    const f = await fixture(t, { legacy, change }); assert.throws(f.plan, error); assert.deepEqual(fs.readdirSync(f.root), []);
  }
});

test('a changed Mac original or unknown tablet base requires a separate destination and never overwrites it', async t => {
  const f = await fixture(t); fs.mkdirSync(path.join(f.root, 'docs'));
  f.options.path = 'docs/Original.md'; const target = path.join(f.root, f.options.path);
  fs.writeFileSync(target, 'Newer Mac original'); f.authority.acceptedBase = () => ({ bytes: Buffer.from('Earlier accepted'), mode: 0o644 });
  assert.throws(f.plan, /changed since this draft/); assert.equal(fs.readFileSync(target, 'utf8'), 'Newer Mac original');
  fs.writeFileSync(target, 'Original document\n'); const plan = f.plan(), result = f.apply(plan.revision);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Original document\n');
  assert.equal(fs.readFileSync(path.join(result.editRoot, f.options.path), 'utf8'), f.content);
  const unknown = await fixture(t, { change(cache, { key, meta }) { cache.set(`draftmeta:${key}`, JSON.stringify({ ...meta, baseKnown: false })); } });
  fs.mkdirSync(path.join(unknown.root, 'docs')); fs.writeFileSync(path.join(unknown.root, unknown.options.path), 'Original document\n');
  unknown.authority.acceptedBase = f.authority.acceptedBase; assert.throws(unknown.plan, /changed since this draft/);
});

test('tablet recovery resumes interrupted acknowledgement and retains later human edits across a new snapshot', async t => {
  const f = await fixture(t), plan = f.plan();
  const write = fs.writeSync;
  fs.writeSync = function(fd, value, ...rest) { if (String(value).includes('"identityHash"')) throw new Error('Synthetic receipt interruption'); return write.call(this, fd, value, ...rest); };
  try { assert.throws(() => f.apply(plan.revision), /Synthetic receipt interruption/); } finally { fs.writeSync = write; }
  const proposals = listLocalProposals(f.root); assert.equal(proposals.length, 1);
  fs.writeFileSync(path.join(proposals[0].editRoot, f.options.path), 'Later human content');
  const result = f.apply(plan.revision); assert.equal(result.proposalId, proposals[0].id);
  assert.equal(fs.readFileSync(path.join(result.editRoot, f.options.path), 'utf8'), 'Later human content');
  execFileSync('python3', ['-B', '-c', "import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute('INSERT INTO cache VALUES(?,?)',('unrelated-new-cache','retained elsewhere'))", path.join(f.source, 'workspace.sqlite')]);
  const output = path.join(f.base, 'later-snapshot'), next = await exportLisiereSnapshot({ source: f.source, output });
  await exportLisiereSnapshot({ source: f.source, output, apply: true, expectedRevision: next.revision });
  f.options.snapshot = output; assert.throws(() => f.apply(plan.revision), /changed after preview/);
  const later = f.plan(); assert.notEqual(later.revision, plan.revision); assert.equal(later.requestId, plan.requestId);
  assert.equal(f.apply(later.revision).proposalId, result.proposalId); assert.equal(listLocalProposals(f.root).length, 1);
  assert.equal(fs.readFileSync(path.join(result.editRoot, f.options.path), 'utf8'), 'Later human content');
});

test('actual CLI imports an Android journal through project permissions and leaves the SQLite snapshot unchanged', async t => {
  const f = await fixture(t); initializeContextRoomProject(f.root, { title: 'Tablet recovery', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  const before = notebookHash(fs.readFileSync(path.join(f.snapshot, 'manifest.json'))), cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
  const args = [cli, 'migrate', '--root', f.root, '--import-lisiere', f.snapshot, '--legacy-draft', f.selector, '--path', f.options.path];
  const settings = { cwd: f.base, encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: f.base,
    CONTEXT_ROOM_HUB_HOME: path.join(f.base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(f.base, 'shared'), CONTEXT_ROOM_REVIEW_AUTHORITY_HOME: path.join(f.base, 'review') } };
  const preview = JSON.parse(execFileSync(process.execPath, args, settings)).data;
  const imported = JSON.parse(execFileSync(process.execPath, [...args, '--apply', '--revision', preview.revision], settings)).data;
  assert.equal(imported.status, 'editing'); assert.equal(imported.accepted, false); assert.equal(imported.source.kind, 'android-workspace');
  assert.equal(fs.existsSync(path.join(f.root, f.options.path)), false);
  assert.equal(fs.readFileSync(path.join(imported.editRoot, f.options.path), 'utf8'), f.content);
  assert.equal(notebookHash(fs.readFileSync(path.join(f.snapshot, 'manifest.json'))), before);
});
