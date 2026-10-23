import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openNotebook, readNotebook, mutateNotebook, undoNotebook, freezeNotebook, readFrozenNotebook, recordNotebookSubmission, notebookReceipt, relocateNotebook, transferNotebook, listNotebooks, NOTEBOOK_STORE, encodeNotebook, decodeNotebook, addNotebookAsset } from '../src/notebooks.mjs';
import { notebookHash, withNotebookLock, readNotebookBytes } from '../src/notebook_io.mjs';
const human = {kind:'human',id:'human-fixture'}, agent = {kind:'agent',id:'agent-fixture'};
const canWrite = value => value.startsWith('docs/') && value.endsWith('.crnb');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'context-room-notebook-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const scene=openNotebook(root,{path:'docs/Sketch.crnb',id:'synthetic-notebook',title:'Synthetic sketch',canWrite});
  const request=(operationId,edits)=>({protocolVersion:1,resourceId:scene.resourceId,operationId,locationRevision:scene.locator.revision,edits});
  return {root,scene,request};
}
const put = (id, type='rect')=>({id,kind:'put',expectedRevision:0,object:{id,type,x:10,y:20,width:80,height:40,...(type==='ink'?{points:[[1,2,.5]]}:{})}});
test('working ink is durable but neither an accepted document nor an ordinary file mutation', t=>{
  const {root,scene,request}=fixture(t);
  const receipt=mutateNotebook(root,request('human-stroke',[put('stroke','ink')]),{actor:human,canWrite});
  assert.equal(receipt.status,'confirmed'); assert.equal(receipt.accepted,false);
  assert.equal(readNotebook(root,scene.resourceId).document.objects.length,1);
  assert.equal(fs.existsSync(path.join(root,'docs/Sketch.crnb')),false);
  assert.equal(fs.existsSync(path.join(root,'.context-room/document-assets/accepted.json')),false);
});
test('same operation is replayed once after a lost response; changed payload and author fail closed',t=>{
  const {root,scene,request}=fixture(t), op=request('lost-response',[put('shape')]);
  mutateNotebook(root,op,{actor:human,canWrite});
  const replay=mutateNotebook(root,{edits:op.edits,locationRevision:op.locationRevision,operationId:op.operationId,resourceId:op.resourceId,protocolVersion:1},{actor:human,canWrite});
  assert.equal(replay.replayed,true); assert.equal(readNotebook(root,scene.resourceId).document.revision,1);
  assert.equal(notebookReceipt(root,scene.resourceId,'lost-response').status,'confirmed');
  assert.equal(notebookReceipt(root,scene.resourceId,'never-received').status,'unknown');
  assert.throws(()=>mutateNotebook(root,{...op,edits:[put('different')]},{actor:human,canWrite}),{code:'notebook_replay_conflict'});
  assert.throws(()=>mutateNotebook(root,op,{actor:agent,canWrite}),{code:'notebook_replay_conflict'});
  assert.throws(()=>mutateNotebook(root,op,{actor:human,canWrite:()=>false}),{code:'notebook_path_scope'});
});
test('two authors, atomic conflicts and selective undo preserve independent work',t=>{
  const {root,scene,request}=fixture(t);
  mutateNotebook(root,request('human-draw',[put('human-ink','ink')]),{actor:human,canWrite});
  mutateNotebook(root,request('agent-draw',[put('agent-box')]),{actor:agent,canWrite});
  assert.throws(()=>mutateNotebook(root,request('conflicting-batch',[put('untouched'),put('agent-box')]),{actor:human,canWrite}),{code:'notebook_object_conflict'});
  assert.equal(readNotebook(root,scene.resourceId).document.objects.length,2);
  undoNotebook(root,{resourceId:scene.resourceId,operationId:'human-undo',undoOf:'human-draw',locationRevision:scene.locator.revision},{actor:human,canWrite});
  assert.deepEqual(readNotebook(root,scene.resourceId).document.objects.map(o=>o.id),['agent-box']);
  assert.throws(()=>undoNotebook(root,{resourceId:scene.resourceId,operationId:'wrong-undo',undoOf:'agent-draw',locationRevision:scene.locator.revision},{actor:human,canWrite}),{code:'notebook_authority'});
});
test('frozen review bytes remain exact while later gestures continue',t=>{
  const {root,scene,request}=fixture(t);
  mutateNotebook(root,request('first',[put('first')]),{actor:agent,canWrite});
  const frozen=freezeNotebook(root,{resourceId:scene.resourceId,operationId:'freeze',expectedRevision:1,locationRevision:scene.locator.revision},{actor:human,canWrite});
  mutateNotebook(root,request('later',[put('later','ink')]),{actor:human,canWrite});
  const snapshot=readFrozenNotebook(root,scene.resourceId,'freeze');
  assert.equal(snapshot.sourceHash,frozen.sourceHash); assert.equal(snapshot.document.objects.length,1);
  assert.equal(readNotebook(root,scene.resourceId).document.objects.length,2);
  assert.throws(()=>freezeNotebook(root,{resourceId:scene.resourceId,operationId:'stale-freeze',expectedRevision:1,locationRevision:scene.locator.revision},{actor:human,canWrite}),{code:'notebook_scene_stale'});
  assert.throws(()=>recordNotebookSubmission(root,{resourceId:scene.resourceId,operationId:'bad-submit',freezeId:'freeze',proposalId:'synthetic',proposalRevision:'revision'},{actor:human,canWrite,verifyProposal:()=>false}),{code:'notebook_submission_conflict'});
  const submitted=recordNotebookSubmission(root,{resourceId:scene.resourceId,operationId:'submit',freezeId:'freeze',proposalId:'synthetic',proposalRevision:'revision'},{actor:human,canWrite,verifyProposal:v=>v.sourceHash===snapshot.sourceHash});
  assert.equal(submitted.accepted,false); assert.equal(submitted.status,'submitted');
  fs.mkdirSync(path.join(root,'docs')); fs.writeFileSync(path.join(root,'docs/Sketch.crnb'),snapshot.bytes);
  mutateNotebook(root,request('after-reviewed-snapshot',[put('still-later')]),{actor:human,canWrite});
  assert.equal(readNotebook(root,scene.resourceId).document.objects.length,3);
});
test('external replacement and moved location reject old operations without losing the draft',t=>{
  const {root,scene,request}=fixture(t);
  mutateNotebook(root,request('before-move',[put('shape')]),{actor:human,canWrite});
  const moved=relocateNotebook(root,{resourceId:scene.resourceId,operationId:'move',locationRevision:scene.locator.revision,path:'docs/Moved.crnb'},{actor:human,canWrite});
  assert.throws(()=>mutateNotebook(root,request('old-location',[put('new-shape')]),{actor:human,canWrite}),{code:'notebook_location_stale'});
  fs.mkdirSync(path.join(root,'docs')); fs.writeFileSync(path.join(root,'docs/Moved.crnb'),'external bytes');
  assert.throws(()=>mutateNotebook(root,{...request('external',[put('new-shape')]),locationRevision:moved.locationRevision},{actor:human,canWrite}),{code:'notebook_external_conflict'});
  assert.equal(readNotebook(root,scene.resourceId).document.objects.length,1);
  assert.equal(fs.readFileSync(path.join(root,'docs/Moved.crnb'),'utf8'),'external bytes');
});
test('path links, damaged frames, incompatible formats and fake image payloads are rejected',t=>{
  const {root,scene,request}=fixture(t);
  assert.throws(()=>decodeNotebook(Buffer.from('{"schemaVersion":99}')),{code:'notebook_version'});
  assert.throws(()=>addNotebookAsset(root,{resourceId:scene.resourceId,operationId:'fake-image',locationRevision:scene.locator.revision,mimeType:'image/png',data:Buffer.from('<script>not a raster</script>').toString('base64')},{actor:human,canWrite}),{code:'notebook_asset'});
  fs.symlinkSync(root,path.join(root,'linked'));
  assert.throws(()=>openNotebook(root,{path:'linked/escape.crnb',canWrite:()=>true}),{code:'notebook_path_scope'});
  mutateNotebook(root,request('retained',[put('shape')]),{actor:human,canWrite});
  const directory=path.join(root,NOTEBOOK_STORE,'resources',scene.resourceId,'events'), frame=fs.readdirSync(directory).find(n=>n.endsWith('.json'));
  fs.writeFileSync(path.join(directory,frame),'truncated');
  assert.throws(()=>readNotebook(root,scene.resourceId),{code:'notebook_recovery_conflict'});
  assert.equal(fs.readFileSync(path.join(directory,frame),'utf8'),'truncated');
});
test('independent processes share canonical object revisions and durable receipts',async t=>{
  const {root,scene}=fixture(t), moduleUrl=new URL('../src/notebooks.mjs',import.meta.url).href;
  const run=prefix=>new Promise((resolve,reject)=>{
    const code=`import {mutateNotebook} from ${JSON.stringify(moduleUrl)};const root=process.env.CR_NOTEBOOK_TEST_ROOT;for(let i=0;i<8;i++)mutateNotebook(root,{protocolVersion:1,resourceId:'synthetic-notebook',operationId:${JSON.stringify(prefix)}+'-op-'+i,locationRevision:${JSON.stringify(scene.locator.revision)},edits:[{kind:'put',id:${JSON.stringify(prefix)}+'-shape-'+i,expectedRevision:0,object:{type:'rect',x:i,y:i}}]},{actor:{kind:'human',id:${JSON.stringify(prefix)}},canWrite:()=>true});`;
    const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,CR_NOTEBOOK_TEST_ROOT:root},stdio:['ignore','pipe','pipe']});let errors='';
    child.stderr.on('data',c=>{errors+=c;});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(errors||`child exit ${code}`)));
  });
  await Promise.all([run('client-one'),run('client-two')]);
  const result=readNotebook(root,scene.resourceId);assert.equal(result.document.objects.length,16);assert.equal(result.document.revision,16);
  assert.equal(notebookReceipt(root,scene.resourceId,'client-one-op-7').status,'confirmed');
  assert.equal(notebookReceipt(root,scene.resourceId,'client-two-op-7').status,'confirmed');
  assert.equal(notebookHash(encodeNotebook(result.document)),notebookHash(encodeNotebook(decodeNotebook(encodeNotebook(result.document)))));
});

test('a contender waits for atomic lock publication, while persistent hardlinks still fail closed', async t => {
  const { root } = fixture(t), rel = `${NOTEBOOK_STORE}/publication.lock`, target = path.join(root, rel);
  const moduleUrl = new URL('../src/filesystem_lock.mjs', import.meta.url).href;
  const code = `import fs from 'node:fs'; import {withFilesystemLock} from ${JSON.stringify(moduleUrl)};
    const target=process.env.CR_NOTEBOOK_TEST_LOCK, link=fs.linkSync;
    fs.linkSync=(from,to)=>{link(from,to);if(to===target){fs.writeSync(1,'published\\n');fs.readSync(0,Buffer.alloc(1),0,1,null);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}};
    withFilesystemLock(target,()=>{});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CR_NOTEBOOK_TEST_LOCK: target }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `child exit ${code}`))); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => { if (code !== 0) reject(new Error(stderr)); }); });
  try {
    assert.equal(fs.lstatSync(target).nlink, 2);
    child.stdin.end('x');
    assert.equal(withNotebookLock(root, rel, () => fs.lstatSync(target).nlink), 1);
  } finally { child.stdin.end(); await exited; }
  const foreign = path.join(root, 'retained-lock-data');
  fs.writeFileSync(foreign, 'Retained synthetic bytes'); fs.linkSync(foreign, target);
  assert.throws(() => withNotebookLock(root, rel, () => assert.fail('linked lock must not be used')), { code: 'notebook_path_scope' });
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'Retained synthetic bytes');
  assert.equal(fs.lstatSync(target).nlink, 2);
  assert.throws(() => readNotebookBytes(root, rel), { code: 'notebook_path_scope' });
});

test('a reader waits for an immutable frame to finish its exclusive publication', async t => {
  const { root } = fixture(t), rel = `${NOTEBOOK_STORE}/synthetic-frame.json`, target = path.join(root, rel);
  const moduleUrl = new URL('../src/notebook_io.mjs', import.meta.url).href;
  const code = `import fs from 'node:fs'; import {writeNotebookBytes} from ${JSON.stringify(moduleUrl)};
    const link=fs.linkSync;fs.linkSync=(from,to)=>{link(from,to);fs.writeSync(1,'published\\n');fs.readSync(0,Buffer.alloc(1),0,1,null);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);};
    writeNotebookBytes(process.env.CR_NOTEBOOK_TEST_ROOT,${JSON.stringify(rel)},Buffer.from('complete frame'),{exclusive:true});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CR_NOTEBOOK_TEST_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `child exit ${code}`))); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => { if (code !== 0) reject(new Error(stderr)); }); });
  try {
    assert.equal(fs.lstatSync(target).nlink, 2); child.stdin.end('x');
    assert.equal(readNotebookBytes(root, rel).toString(), 'complete frame');
    assert.equal(fs.lstatSync(target).nlink, 1);
  } finally { child.stdin.end(); await exited; }
});

function secondRoot(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'context-room-notebook-space-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root;
}
const spaceWrite = value => value.startsWith('Carnets/') && value.endsWith('.crnb');
const move = (from, to, resourceId, target, operationId, writes = [canWrite, spaceWrite]) => {
  const options = { canWriteSource: writes[0], canWriteTarget: writes[1] };
  const preview = transferNotebook(from, to, { resourceId, path: target }, { ...options, preview: true });
  return transferNotebook(from, to, { resourceId, path: target, operationId, expectedRevision: preview.revision }, options);
};
test('transfer moves a working notebook to another root and back', t=>{
  const {root,scene,request}=fixture(t), space=secondRoot(t);
  mutateNotebook(root,request('ink',[put('stroke','ink'),put('gone')]),{actor:human,canWrite});
  mutateNotebook(root,request('erase',[{id:'gone',kind:'delete',expectedRevision:1}]),{actor:human,canWrite});
  const before=readNotebook(root,scene.resourceId);
  const preview=transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/Sketch.crnb'},{canWriteSource:canWrite,canWriteTarget:spaceWrite,preview:true});
  assert.equal(preview.preview,true); assert.equal(preview.overwrites,false); assert.equal(preview.from.path,'docs/Sketch.crnb');
  assert.equal(listNotebooks(space).length,0);
  const moved=transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/Sketch.crnb',operationId:'move-out',expectedRevision:preview.revision},{canWriteSource:canWrite,canWriteTarget:spaceWrite,destination:{projectId:'space'}});
  assert.equal(moved.moved,true); assert.equal(moved.to.projectId,'space'); assert.notEqual(moved.from.serverId,moved.to.serverId);
  const there=readNotebook(space,scene.resourceId);
  assert.deepEqual(there.document,before.document); assert.deepEqual(there.tombstones,{gone:2});
  assert.deepEqual(listNotebooks(root),[]); assert.equal(listNotebooks(space)[0].path,'Carnets/Sketch.crnb'); assert.ok(listNotebooks(space)[0].changedAt);
  assert.throws(()=>readNotebook(root,scene.resourceId),error=>error.code==='notebook_moved'&&error.statusCode===409&&error.details.destination.path==='Carnets/Sketch.crnb');
  assert.throws(()=>mutateNotebook(root,request('late',[put('late')]),{actor:human,canWrite}),{code:'notebook_moved'});
  assert.ok(fs.existsSync(path.join(root,NOTEBOOK_STORE,'retired',`${scene.resourceId}-move-out`,'header.json')),'the source is retained');
  assert.equal(transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/Sketch.crnb',operationId:'move-out',expectedRevision:preview.revision},{canWriteSource:canWrite,canWriteTarget:spaceWrite}).replayed,true);
  mutateNotebook(space,{protocolVersion:1,resourceId:scene.resourceId,operationId:'more-ink',locationRevision:there.locator.revision,edits:[put('more','ink')]},{actor:human,canWrite:spaceWrite});
  const back=move(space,root,scene.resourceId,'docs/Sketch.crnb','move-back',[spaceWrite,canWrite]);
  assert.equal(back.moved,true);
  const home=readNotebook(root,scene.resourceId);
  assert.deepEqual(home.document.objects.map(o=>o.id).sort(),['more','stroke']);
  assert.notEqual(home.locator.revision,scene.locator.revision,'an old location revision does not come back');
  assert.throws(()=>readNotebook(space,scene.resourceId),{code:'notebook_moved'});
  mutateNotebook(root,{protocolVersion:1,resourceId:scene.resourceId,operationId:'home-ink',locationRevision:home.locator.revision,edits:[put('home','ink')]},{actor:human,canWrite});
});
test('transfer refuses to overwrite an occupied path or id', t=>{
  const {root,scene}=fixture(t), space=secondRoot(t);
  openNotebook(space,{path:'Carnets/Taken.crnb',id:'other-notebook',canWrite:spaceWrite});
  assert.throws(()=>transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/Taken.crnb'},{canWriteSource:canWrite,canWriteTarget:spaceWrite,preview:true}),{code:'notebook_location_conflict'});
  fs.mkdirSync(path.join(space,'Carnets'),{recursive:true}); fs.writeFileSync(path.join(space,'Carnets/File.crnb'),'{}');
  assert.throws(()=>transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/File.crnb'},{canWriteSource:canWrite,canWriteTarget:spaceWrite,preview:true}),{code:'notebook_location_conflict'});
  openNotebook(space,{path:'Carnets/Same-id.crnb',id:scene.resourceId,canWrite:spaceWrite});
  assert.throws(()=>transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/Free.crnb'},{canWriteSource:canWrite,canWriteTarget:spaceWrite,preview:true}),{code:'notebook_location_conflict'});
  assert.throws(()=>transferNotebook(root,space,{resourceId:scene.resourceId,path:'Elsewhere/Free.crnb'},{canWriteSource:canWrite,canWriteTarget:spaceWrite,preview:true}),{code:'notebook_path_scope'});
  assert.throws(()=>transferNotebook(root,root,{resourceId:scene.resourceId,path:'docs/Other.crnb'},{canWriteSource:canWrite,canWriteTarget:canWrite,preview:true}),{code:'notebook_location_conflict'});
  const clean=secondRoot(t), preview=transferNotebook(root,clean,{resourceId:scene.resourceId,path:'Carnets/Free.crnb'},{canWriteSource:canWrite,canWriteTarget:spaceWrite,preview:true});
  assert.throws(()=>transferNotebook(root,clean,{resourceId:scene.resourceId,path:'Carnets/Free.crnb',operationId:'stale',expectedRevision:'0'.repeat(64)},{canWriteSource:canWrite,canWriteTarget:spaceWrite}),{code:'notebook_location_stale'});
  assert.equal(readNotebook(root,scene.resourceId).resourceId,scene.resourceId); assert.equal(listNotebooks(clean).length,0); assert.ok(preview.revision);
});
test('transfer replays after a crash between copy and retirement', t=>{
  const {root,scene,request}=fixture(t), space=secondRoot(t);
  mutateNotebook(root,request('ink',[put('stroke','ink')]),{actor:human,canWrite});
  const options={canWriteSource:canWrite,canWriteTarget:spaceWrite};
  const preview=transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/Sketch.crnb'},{...options,preview:true});
  const rename=fs.renameSync; fs.renameSync=(from,to)=>{ if(String(to).includes('/retired/')) throw Object.assign(new Error('simulated crash'),{code:'EIO'}); return rename(from,to); };
  try { assert.throws(()=>transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/Sketch.crnb',operationId:'crash',expectedRevision:preview.revision},options),/simulated crash/); }
  finally { fs.renameSync=rename; }
  assert.equal(readNotebook(space,scene.resourceId).document.objects.length,1);
  assert.throws(()=>readNotebook(root,scene.resourceId),{code:'notebook_moved'});
  assert.ok(fs.existsSync(path.join(root,NOTEBOOK_STORE,'resources',scene.resourceId,'header.json')));
  assert.throws(()=>transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/Other.crnb',operationId:'crash',expectedRevision:preview.revision},options),{code:'notebook_replay_conflict'});
  const resumed=transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/Sketch.crnb',operationId:'crash',expectedRevision:preview.revision},options);
  assert.equal(resumed.replayed,true);
  assert.equal(fs.existsSync(path.join(root,NOTEBOOK_STORE,'resources',scene.resourceId)),false);
  assert.ok(fs.existsSync(path.join(root,NOTEBOOK_STORE,'retired',`${scene.resourceId}-crash`,'header.json')));
  assert.deepEqual(listNotebooks(space).map(n=>n.id),[scene.resourceId]);
});
test('transfer refuses a published notebook', t=>{
  const {root,scene,request}=fixture(t), space=secondRoot(t);
  mutateNotebook(root,request('ink',[put('stroke','ink')]),{actor:human,canWrite});
  freezeNotebook(root,{resourceId:scene.resourceId,operationId:'freeze',expectedRevision:1,locationRevision:scene.locator.revision},{actor:human,canWrite});
  recordNotebookSubmission(root,{resourceId:scene.resourceId,operationId:'submit',freezeId:'freeze',proposalId:'synthetic',proposalRevision:'revision'},{actor:human,canWrite,verifyProposal:()=>true});
  assert.throws(()=>transferNotebook(root,space,{resourceId:scene.resourceId,path:'Carnets/Sketch.crnb'},{canWriteSource:canWrite,canWriteTarget:spaceWrite,preview:true}),error=>error.code==='notebook_move_published'&&error.statusCode===409);
  const other=fixture(t); fs.mkdirSync(path.join(other.root,'docs')); fs.writeFileSync(path.join(other.root,'docs/Sketch.crnb'),encodeNotebook(readNotebook(other.root,other.scene.resourceId).document));
  assert.throws(()=>transferNotebook(other.root,space,{resourceId:other.scene.resourceId,path:'Carnets/Sketch.crnb'},{canWriteSource:canWrite,canWriteTarget:spaceWrite,preview:true}),{code:'notebook_move_published'});
  assert.equal(readNotebook(root,scene.resourceId).document.objects.length,1);
});
