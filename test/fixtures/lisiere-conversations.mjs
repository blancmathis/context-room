import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportLisiereSnapshot } from '../../src/lisiere_snapshot.mjs';
import { inspectLisiereSnapshot } from '../../src/lisiere_inventory.mjs';

/** Entirely synthetic SQLite history; never reads a user's legacy installation. */
export async function legacyConversationSnapshot(base, { desktop = false, extraMessages = 0, longText = '', extraRecordBytes = 0, binaryContext = false } = {}) {
  const source = path.join(base, 'legacy-conversation-source'), snapshot = path.join(base, 'legacy-conversation-snapshot'); fs.mkdirSync(source);
  const parameters = path.join(base, 'synthetic-conversation-input.json'); fs.writeFileSync(parameters, JSON.stringify({ desktop, extraMessages, longText, extraRecordBytes, binaryContext }), { mode: 0o600 });
  execFileSync('python3', ['-B', '-c', `import sqlite3,json,sys,struct
p=json.load(open(sys.argv[2]))
def text(value):
 b=value.encode('utf-16-be','surrogatepass'); return struct.pack('>i',len(b)//2)+b
def lsj(value):
 if isinstance(value,dict): return bytes([1])+struct.pack('>i',len(value))+b''.join(text(k)+lsj(v) for k,v in value.items())
 if isinstance(value,str): return bytes([3])+text(value)
 if isinstance(value,int): return bytes([6])+struct.pack('>q',value)
 raise ValueError('Unsupported synthetic LSJ value')
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root TEXT); CREATE TABLE boards(id TEXT PRIMARY KEY,title TEXT,project TEXT,revision INTEGER); CREATE TABLE objects(board TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(board,id)); CREATE TABLE conversations(id TEXT PRIMARY KEY,project TEXT,thread TEXT,title TEXT,created REAL); CREATE TABLE messages(seq INTEGER PRIMARY KEY,conversation TEXT,kind TEXT,data TEXT,time REAL); CREATE TABLE native_bindings(id TEXT PRIMARY KEY,thread TEXT); CREATE TABLE native_requests(id TEXT PRIMARY KEY,conversation TEXT,text TEXT,context TEXT,active INTEGER);')
 db.execute('INSERT INTO projects VALUES(?,?,?)',('legacy-project','Synthetic original','/synthetic/original'))
 for c in ['original','other']:
  db.execute('INSERT INTO conversations VALUES(?,?,?,?,?)',(c,'legacy-project','retained-task-'+c,'Synthetic '+c,1700000000))
 events=[('user',{'text':'Original human question 🖊️','context':{'project':'legacy-project','document':{'path':'old/Original.md'}}}),('turn/started',{'turn':{'id':'original-turn'}}),('item/agentMessage/delta',{'turnId':'original-turn','itemId':'answer','delta':'Original partial '}),('item/agentMessage/delta',{'turnId':'original-turn','itemId':'answer','delta':'answer'}),('item/completed',{'turnId':'original-turn','item':{'id':'answer','type':'agentMessage','text':'Original complete answer.'+p['longText']}}),('turn/completed',{'turn':{'id':'original-turn','status':'completed'}}),('unknown/future-event',{'uninterpreted':['exact',17,False]}),('item/agentMessage/delta',{'turnId':'interrupted-turn','itemId':'partial','delta':'Retained unfinished answer.'})]
 events.extend(('user',{'text':'Retained additional question '+str(n),'context':{'originalIndex':n}}) for n in range(p['extraMessages']))
 events[6][1]['additionalOriginalData']='R'*p['extraRecordBytes']
 if p['binaryContext']: events[0][1]['context']['revision']=9007199254740997
 for n,(kind,data) in enumerate(events):
  packed=b'LSJ1'+lsj(data) if n==0 and p['binaryContext'] else json.dumps(data,ensure_ascii=False)
  db.execute('INSERT INTO messages VALUES(?,?,?,?,?)',(9007199254740995+n,'original',kind,packed,1700000000+n))
 db.execute('INSERT INTO messages VALUES(?,?,?,?,?)',(1,'other','user',json.dumps({'text':'Another conversation must stay outside this import.'}),1700000000))
 if p['desktop']:
  db.execute('INSERT INTO native_bindings VALUES(?,?)',('original','retained-task-original'))
  db.execute('INSERT INTO native_requests VALUES(?,?,?,?,?)',('pending-original-request','original','Original delivery remains unknown.',json.dumps({'document':{'path':'old/Pending.md'}}),1))
`, path.join(source, 'workspace.sqlite'), parameters], { stdio: 'pipe' });
  const preview = await exportLisiereSnapshot({ source, output: snapshot });
  await exportLisiereSnapshot({ source, output: snapshot, apply: true, expectedRevision: preview.revision });
  const selector = inspectLisiereSnapshot(snapshot, { kind: 'conversations' }).items.find(item => item.id === 'original').selector;
  return { source, snapshot, selector };
}
