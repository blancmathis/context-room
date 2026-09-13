import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openNotebook, readNotebook, mutateNotebook, undoNotebook, freezeNotebook, readFrozenNotebook, recordNotebookSubmission, notebookReceipt, relocateNotebook, NOTEBOOK_STORE, encodeNotebook, decodeNotebook, addNotebookAsset } from '../src/notebooks.mjs';
import { notebookHash } from '../src/notebook_io.mjs';
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
