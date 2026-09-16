import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportLisiereSnapshot } from '../../src/lisiere_snapshot.mjs';

/** Real, wholly synthetic SQLite exports with a lost response and two successors. */
export async function reconciliationFixture(base) {
  const macSource = path.join(base, 'old-mac'), androidSource = path.join(base, 'old-tablet');
  fs.mkdirSync(macSource); fs.mkdirSync(androidSource);
  execFileSync('python3', ['-B', '-c', `import sqlite3,json,hashlib,sys
packed=lambda v:json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))
ops=[{'id':'shape','expectedRevision':0,'value':{'type':'rect','x':0,'y':0,'w':80,'h':60}}]
after=dict(ops[0]['value'],id='shape',revision=1,actor='tablet')
result={'board':'original-board','revision':1,'operationId':'lost-response','objects':[after],'dryRun':False}
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root TEXT);CREATE TABLE boards(id TEXT PRIMARY KEY,title TEXT,project TEXT,anchor TEXT,revision INTEGER,directory TEXT);CREATE TABLE objects(board TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(board,id));CREATE TABLE operations(id TEXT PRIMARY KEY,hash TEXT,result TEXT);CREATE TABLE history(id TEXT PRIMARY KEY,board TEXT,actor TEXT,changes TEXT,time REAL,undone INTEGER);CREATE TABLE board_creations(id TEXT PRIMARY KEY,hash TEXT);')
 db.execute('INSERT INTO boards VALUES(?,?,?,?,?,?)',('original-board','Retained memo',None,None,2,''))
 db.execute('INSERT INTO objects VALUES(?,?,?,?)',('original-board','shape',1,packed(after)))
 db.execute('INSERT INTO objects VALUES(?,?,?,?)',('original-board','mac-independent',2,packed({'type':'text','id':'mac-independent','revision':2,'text':'Independent Mac work','x':100,'y':40,'w':120,'h':30})))
 db.execute('INSERT INTO operations VALUES(?,?,?)',('lost-response',hashlib.sha256(packed(['original-board',ops,'tablet',None]).encode()).hexdigest(),packed(result)))
 db.execute('INSERT INTO history VALUES(?,?,?,?,?,?)',('lost-response','original-board','tablet',packed([{'id':'shape','before':None,'after':after,'afterRevision':1}]),1,0))
with sqlite3.connect(sys.argv[2]) as db:
 db.executescript('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,operation TEXT,args TEXT,error TEXT);')
 for n,identity in enumerate(['lost-response','pending-successor','second-successor']):
  changed=json.loads(packed(ops));changed[0]['value']['x']=n*40
  db.execute('INSERT INTO outbox VALUES(?,?,?,?,?)',(9007199254740993+n,identity,'board.mutate',packed({'board':'original-board','operationId':identity,'operations':changed}),None))
`, path.join(macSource, 'workspace.sqlite'), path.join(androidSource, 'workspace.sqlite')], { stdio: 'pipe' });
  const snapshots = [];
  for (const [source, name] of [[macSource, 'mac'], [androidSource, 'android']]) {
    const output = path.join(base, name + '-snapshot'), plan = await exportLisiereSnapshot({ source, output });
    await exportLisiereSnapshot({ source, output, apply: true, expectedRevision: plan.revision }); snapshots.push(output);
  }
  return { macSource, androidSource, macSnapshot: snapshots[0], androidSnapshot: snapshots[1], boardId: 'original-board', actor: 'tablet', path: 'docs/Recovered.crnb' };
}
