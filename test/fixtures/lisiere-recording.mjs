import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportLisiereSnapshot } from '../../src/lisiere_snapshot.mjs';

export async function recordingFixture(base) {
  const source = path.join(base, 'legacy-audio-database'), recordings = path.join(base, 'legacy-audio-files'), snapshot = path.join(base, 'audio-snapshot');
  fs.mkdirSync(source); fs.mkdirSync(recordings);
  execFileSync('python3', ['-B', '-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.executescript('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,operation TEXT,args TEXT,error TEXT);')`, path.join(source, 'workspace.sqlite')], { stdio: 'pipe' });
  const name = 'c'.repeat(64) + '.pcm', pcm = Buffer.alloc(32000);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i / 30) * 6000), i);
  fs.writeFileSync(path.join(recordings, name), pcm);
  const plan = await exportLisiereSnapshot({ source, recordings, output: snapshot });
  await exportLisiereSnapshot({ source, recordings, output: snapshot, apply: true, expectedRevision: plan.revision });
  return { source, recordings, snapshot, name, pcm };
}
