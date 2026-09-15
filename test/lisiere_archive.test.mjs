import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { notebookHash, stableNotebookJson } from '../src/notebook_io.mjs';
import { exportLisiereSnapshot } from '../src/lisiere_snapshot.mjs';
import { readLisiereSnapshot, decodeLisiereObject, recoverLisiereDraft } from '../src/lisiere_archive.mjs';

// LSJ1 object with Java double 1.5 and three exact UTF-16 code units A, D83D, B.
const binary = Buffer.from('4c534a310100000002000000010078083ff800000000000000000004007400650078007403000000030041d83d0042', 'hex');

async function fixture(t, kind = 'mac') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-legacy-archive-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), output = path.join(base, 'export'); fs.mkdirSync(source);
  execFileSync('python3', ['-B', '-c', `import sqlite3,sys,base64,json,hashlib
from pathlib import Path
source=Path(sys.argv[1])
with sqlite3.connect(source/'workspace.sqlite') as db:
 if sys.argv[2]=='mac':
  db.executescript('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root TEXT); CREATE TABLE boards(id TEXT PRIMARY KEY,title TEXT,project TEXT,revision INTEGER); CREATE TABLE objects(board TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(board,id));')
  db.execute('INSERT INTO projects VALUES(?,?,?)',('p','Synthetic','/synthetic/project'))
  db.execute('INSERT INTO boards VALUES(?,?,?,?)',('board','Long source','p',4))
  db.execute('INSERT INTO objects VALUES(?,?,?,?)',('board','text',4,json.dumps({'type':'text','text':'é'*40000},ensure_ascii=False)))
  payload=bytes(range(251))*1000
  (source/'assets').mkdir()
  (source/'assets'/hashlib.sha256(payload).hexdigest()).write_bytes(payload)
 else:
  db.executescript('PRAGMA user_version=1; CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,operation TEXT,args TEXT,error TEXT); CREATE TABLE board_objects(board TEXT,id TEXT,value BLOB,PRIMARY KEY(board,id));')
  db.execute('INSERT INTO board_objects VALUES(?,?,?)',('b','text',base64.b64decode(sys.argv[3])))
  db.execute('INSERT INTO outbox VALUES(?,?,?,?,?)',(9007199254740993,'op','board.mutate','{}','uncertain'))
`, source, kind, binary.toString('base64')], { timeout: 10000, stdio: 'pipe' });
  const plan = await exportLisiereSnapshot({ source, output });
  await exportLisiereSnapshot({ source, output, apply: true, expectedRevision: plan.revision });
  return { base, source, output, manifest: JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'))) };
}
function replaceManifest(output, change) {
  const { revision: _, ...manifest } = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'))); change(manifest);
  const value = stableNotebookJson({ ...manifest, revision: notebookHash(manifest) }) + '\n';
  for (const name of ['manifest.json', 'export-journal.json']) fs.writeFileSync(path.join(output, name), value);
}

test('a real exported Mac snapshot reads long UTF-8 rows and original multi-buffer assets exactly', async t => {
  const { source, output, manifest } = await fixture(t), archive = readLisiereSnapshot(output);
  assert.equal(archive.manifest.revision, manifest.revision);
  assert.equal(decodeLisiereObject([...archive.rows('objects')][0].data).text, 'é'.repeat(40000));
  assert.deepEqual([...archive.rows('absent')], []);
  const asset = manifest.files.find(entry => entry.path.startsWith('assets/'));
  assert.deepEqual(archive.asset(asset.sha256), fs.readFileSync(path.join(source, asset.path)));
  assert.equal(notebookHash(archive.asset(asset.sha256)), asset.sha256);
});

test('Android binary cells, int64 operation order and incomplete UTF-16 text survive the actual export', async t => {
  const { output } = await fixture(t, 'android'), archive = readLisiereSnapshot(output);
  assert.equal([...archive.rows('outbox')][0].seq, 9007199254740993n);
  const original = [...archive.rows('board_objects')][0].value; assert.deepEqual(original, binary);
  const object = decodeLisiereObject(original);
  assert.equal(object.x, 1.5); assert.equal(object.text, 'A\ud83dB'); assert.equal(object.text.length, 3);
});

test('incomplete, altered, unlisted or linked recovery data is refused before an import', async t => {
  const { output, base, manifest } = await fixture(t);
  const archive = readLisiereSnapshot(output), table = path.join(output, 'tables/objects.jsonl'), bytes = fs.readFileSync(table);
  fs.writeFileSync(table, bytes.toString().replace('text', 'xxxx'));
  assert.throws(() => [...archive.rows('objects')], /snapshot hash/);
  assert.throws(() => readLisiereSnapshot(output), /snapshot hash/);
  fs.writeFileSync(table, bytes);
  fs.renameSync(table, path.join(base, 'linked-table'));
  fs.symlinkSync(path.join(base, 'linked-table'), table);
  assert.throws(() => readLisiereSnapshot(output), /Linked|linked/);
  fs.unlinkSync(table); fs.renameSync(path.join(base, 'linked-table'), table);
  replaceManifest(output, next => { next.tables.find(row => row.name === 'objects').rows++; });
  assert.throws(() => readLisiereSnapshot(output), /row count/);
  replaceManifest(output, next => { Object.assign(next, { ...manifest }); delete next.revision; next.files[0].path = '../outside'; });
  assert.throws(() => readLisiereSnapshot(output), /file entry/);
  fs.unlinkSync(path.join(output, 'manifest.json'));
  assert.throws(() => readLisiereSnapshot(output), /unfinished/);
});

test('binary decoding rejects unknown versions, truncation, trailing data and non-finite numbers', () => {
  for (let length = 0; length < binary.length; length++) assert.throws(() => decodeLisiereObject(binary.subarray(0, length)), /binary JSON/);
  assert.throws(() => decodeLisiereObject(Buffer.concat([binary, Buffer.from([0])])), /envelope/);
  const version = Buffer.from(binary); version.write('LSJ2'); assert.throws(() => decodeLisiereObject(version), /version/);
  const infinite = Buffer.from(binary); infinite.writeDoubleBE(Infinity, 16); assert.throws(() => decodeLisiereObject(infinite), /Non-finite/);
  assert.throws(() => decodeLisiereObject('[]'), /object is required/);
});

function draft() {
  const key = 'project:docs/Idea.md', epoch = 'draft-epoch', seed = 'A🖊️B';
  const first = `draftdelta:${epoch}:${String(101).padStart(20, '0')}`, second = `draftdelta:${epoch}:${String(107).padStart(20, '0')}`;
  // The first edit replaces the complete pen emoji in UTF-16. The second edit
  // deliberately retains a lone surrogate from an interrupted composition.
  const text = 'Aé\ud83dB';
  const meta = { project: 'project', path: 'docs/Idea.md', epoch, base: 'original-hash', baseKnown: true, seedVersion: 100, version: 107, ack: 100, length: text.length, changed: true };
  const cache = new Map([
    [`draftdoc:${key}`, seed], [`draftmeta:${key}`, JSON.stringify(meta)],
    [second, JSON.stringify({ edits: [{ start: 2, removed: 0, inserted: '\ud83d' }] })],
    [first, JSON.stringify({ start: 1, removed: 3, inserted: 'é' })],
    [`draftdelta:old-epoch:${String(999).padStart(20, '0')}`, '{}'],
  ]);
  return { key, epoch, seed, first, second, text, meta, cache };
}
test('UTF-16 drafts replay sorted deltas without changing acknowledgements, original seeds or old epochs', () => {
  const { key, cache, text, first, second } = draft(), before = [...cache];
  const recovered = recoverLisiereDraft(cache, key);
  assert.equal(recovered.content, text); assert.equal(recovered.pending, true); assert.equal(recovered.accepted, false);
  assert.equal(recovered.version, 107); assert.equal(recovered.acknowledgedVersion, 100);
  assert.deepEqual(recovered.consumedDeltas, [first, second]); assert.deepEqual([...cache], before);
});
test('missing final delta, missing seed, wrong identity, invalid ranges and incomplete compacted drafts are refused', () => {
  const { key, cache, first, second, meta } = draft();
  const change = work => { const edited = new Map(cache); work(edited); return edited; };
  assert.throws(() => recoverLisiereDraft(change(next => next.delete(second)), key), /latest.*missing/);
  assert.throws(() => recoverLisiereDraft(change(next => next.delete(`draftdoc:${key}`)), key), /seed is missing/);
  assert.throws(() => recoverLisiereDraft(cache, 'foreign:docs/Idea.md'), /binary JSON version/);
  assert.throws(() => recoverLisiereDraft(change(next => next.set(first, '{"start":99,"removed":0,"inserted":"x"}')), key), /UTF-16 range/);
  assert.throws(() => recoverLisiereDraft(change(next => next.set(`draftmeta:${key}`, JSON.stringify({ ...meta, seedVersion: 107 }))), key), /incomplete/);
  const compacted = change(next => { next.set(`draftdoc:${key}`, 'Ready'); next.set(`draftmeta:${key}`, JSON.stringify({ ...meta, seedVersion: 107, ack: 107, length: 5 })); });
  const result = recoverLisiereDraft(compacted, key); assert.equal(result.content, 'Ready'); assert.equal(result.pending, false); assert.equal(result.accepted, false);
  assert.deepEqual(result.consumedDeltas, []);
});
