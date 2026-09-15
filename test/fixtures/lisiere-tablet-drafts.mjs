import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { notebookHash } from '../../src/notebook_io.mjs';
import { exportLisiereSnapshot } from '../../src/lisiere_snapshot.mjs';
import { inspectLisiereSnapshot } from '../../src/lisiere_inventory.mjs';

/** Synthetic Android cache with timestamp gaps and exact Java UTF-16 edits. */
export async function tabletDraftSnapshot(base, { legacy = false, change = () => {} } = {}) {
  const key = 'original-project:docs/Original.md', epoch = 'original-draft-epoch';
  const seed = '\ufeff# Tablet ideas\r\n\r\nOriginal 🖊️\r\n', content = seed.replace('Original', 'Retained') + 'A later offline addition.\r\n';
  const meta = { project: 'original-project', path: 'docs/Original.md', epoch, base: notebookHash(Buffer.from('Original document\n')), baseKnown: true,
    version: 107, seedVersion: 100, ack: 101, length: content.length, changed: true };
  const cache = new Map([[`draftdoc:${key}`, legacy ? content : seed], [`draftclock:${key}`, '9007199254740993'],
    ['draftdoc:another-project:docs/Secret.md', 'Unrelated synthetic text must not enter this import.'],
    ['native-request:another-conversation', JSON.stringify({ message: 'Do not replay this synthetic request.' })]]);
  if (legacy) cache.set(`dirtydraft:${key}`, JSON.stringify({ project: meta.project, path: meta.path, base: meta.base, content, version: meta.version }));
  else {
    cache.set(`draftmeta:${key}`, JSON.stringify(meta));
    cache.set(`draftdelta:${epoch}:${'101'.padStart(20, '0')}`, { binary: { start: seed.indexOf('Original'), removed: 8, inserted: 'Retained' } });
    cache.set(`draftdelta:${epoch}:${'107'.padStart(20, '0')}`, JSON.stringify({ edits: [{ start: seed.length, removed: 0, inserted: 'A later offline addition.\r\n' }] }));
  }
  change(cache, { key, epoch, seed, content, meta });
  const source = path.join(base, 'tablet-source'), snapshot = path.join(base, 'tablet-snapshot'); fs.mkdirSync(source);
  const parameters = path.join(base, 'synthetic-tablet-input.json'); fs.writeFileSync(parameters, JSON.stringify([...cache]), { mode: 0o600 });
  execFileSync('python3', ['-B', '-c', `import sqlite3,json,struct,sys
def text(value):
 b=value.encode('utf-16-be','surrogatepass'); return struct.pack('>i',len(b)//2)+b
def lsj(value):
 if isinstance(value,dict): return bytes([1])+struct.pack('>i',len(value))+b''.join(text(k)+lsj(v) for k,v in value.items())
 if isinstance(value,list): return bytes([2])+struct.pack('>i',len(value))+b''.join(lsj(v) for v in value)
 if isinstance(value,str): return bytes([3])+text(value)
 if isinstance(value,int): return bytes([6])+struct.pack('>q',value)
 raise ValueError('Unsupported synthetic LSJ value')
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,operation TEXT,args TEXT,error TEXT);')
 for key,value in json.load(open(sys.argv[2])):
  db.execute('INSERT INTO cache VALUES(?,?)',(key,b'LSJ1'+lsj(value['binary']) if isinstance(value,dict) else value))
 db.execute('INSERT INTO outbox VALUES(?,?,?,?,?)',(9007199254740993,'pending-board-operation','board.mutate','{"board":"another-board","operations":[]}',None))
`, path.join(source, 'workspace.sqlite'), parameters], { stdio: 'pipe' });
  const preview = await exportLisiereSnapshot({ source, output: snapshot });
  await exportLisiereSnapshot({ source, output: snapshot, apply: true, expectedRevision: preview.revision });
  const selectedKey = (legacy ? 'dirtydraft:' : 'draftmeta:') + key;
  const selector = inspectLisiereSnapshot(snapshot, { kind: 'drafts' }).items.find(item => item.sourceKey === selectedKey)?.selector;
  return { source, snapshot, selector, key, epoch, seed, content, meta, cache };
}
