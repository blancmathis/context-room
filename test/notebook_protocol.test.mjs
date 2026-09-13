import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyNotebook, applyNotebookEdits, normalizeNotebookDocument, normalizeNotebookObject, notebookPath, notebookId, NOTEBOOK_VERSION, NOTEBOOK_MIME } from '../src/notebook_protocol.mjs';
const human = {kind:'human',id:'human-test'}, agent = {kind:'agent',id:'agent-test'};
const put = (id, type = 'rect') => ({id,kind:'put',expectedRevision:0,object:{id,type,x:10,y:20,width:100,height:60,...(type==='ink'?{points:[[1,2,.5]]}:{})}});
function scene() { return emptyNotebook('notebook-test', 'Synthetic notebook'); }
test('format is specific, versioned and does not accept arbitrary JSON', () => {
  assert.equal(scene().schemaVersion,NOTEBOOK_VERSION); assert.equal(scene().mediaType,NOTEBOOK_MIME);
  assert.throws(()=>normalizeNotebookDocument({objects:[]}),{code:'notebook_version'});
  assert.throws(()=>normalizeNotebookDocument({...scene(),schemaVersion:2}),{code:'notebook_version'});
  assert.equal(notebookPath('ordinary/Sketch.crnb'),'ordinary/Sketch.crnb');
  for(const p of ['/tmp/x.crnb','../x.crnb','a/../x.crnb','a//x.crnb','a\\x.crnb','.git/x.crnb','a/.context-room/x.crnb','a/note.json','a/\0x.crnb','node_modules/x.crnb']) assert.throws(()=>notebookPath(p));
  for(const id of ['__proto__','constructor','prototype','../test','',1]) assert.throws(()=>notebookId(id));
});
test('independent authors can edit different objects without replacing the whole scene', () => {
  const first=applyNotebookEdits(scene(),{},[put('human-line','ink')],human);
  const second=applyNotebookEdits(first.document,{},[put('agent-box')],agent);
  assert.equal(first.document.objects.length,1); assert.equal(second.document.objects.length,2);
  assert.equal(second.document.revision,2); assert.deepEqual(second.document.objects[0].createdBy,human);
  assert.deepEqual(second.document.objects[1].createdBy,agent);
});
test('one conflicting object rejects the complete batch with recoverable current values', () => {
  const first=applyNotebookEdits(scene(),{},[put('first')],agent);
  assert.throws(()=>applyNotebookEdits(first.document,{},[put('second'),put('first')],human),e=>e.code==='notebook_object_conflict' && e.details.conflicts[0].actualRevision===1);
  assert.equal(first.document.objects.length,1); assert.equal(first.document.revision,1);
});
test('only the owning author appends to a progressive stroke', () => {
  const first=applyNotebookEdits(scene(),{},[put('stroke','ink')],agent);
  const append={kind:'append',id:'stroke',expectedRevision:1,points:[[3,4,.8],[5,6,.2]]};
  assert.throws(()=>applyNotebookEdits(first.document,{},[append],human),{code:'notebook_authority'});
  const next=applyNotebookEdits(first.document,{},[append],agent);
  assert.equal(next.document.objects[0].points.length,3); assert.equal(next.document.objects[0].revision,2);
  assert.equal(first.document.objects[0].points.length,1);
});
test('human transformations preserve agent origin and cannot forge authorship', () => {
  const first=applyNotebookEdits(scene(),{},[put('shape')],agent);
  const patch={id:'shape',kind:'patch',expectedRevision:1,patch:{x:50}};
  const next=applyNotebookEdits(first.document,{},[patch],human).document;
  assert.deepEqual(next.objects[0].createdBy,agent); assert.deepEqual(next.objects[0].updatedBy,human);
  assert.throws(()=>applyNotebookEdits(first.document,{},[{...patch,patch:{createdBy:human}}],human),{code:'notebook_patch'});
});
test('deletion tombstones prevent stale resurrection and exact restoration is possible', () => {
  const first=applyNotebookEdits(scene(),{},[put('shape')],human);
  const removed=applyNotebookEdits(first.document,{},[{id:'shape',kind:'delete',expectedRevision:1}],human);
  assert.equal(removed.document.objects.length,0);
  assert.throws(()=>applyNotebookEdits(removed.document,{shape:2},[put('shape')],human),{code:'notebook_object_conflict'});
  const restored=applyNotebookEdits(removed.document,{shape:2},[{...put('shape'),expectedRevision:2}],human);
  assert.equal(restored.document.objects[0].revision,3);
});
test('locked objects require explicit unlock, not replacement or deletion', () => {
  const first=applyNotebookEdits(scene(),{},[{...put('shape'),object:{...put('shape').object,locked:true}}],human).document;
  assert.throws(()=>applyNotebookEdits(first,{},[{kind:'delete',id:'shape',expectedRevision:1}],agent),{code:'notebook_locked_conflict'});
  const unlocked=applyNotebookEdits(first,{},[{kind:'patch',id:'shape',expectedRevision:1,patch:{locked:false}}],human).document;
  assert.equal(unlocked.objects[0].locked,false);
});
test('visual inputs refuse executable resources, nonfinite geometry and oversized content', () => {
  assert.throws(()=>normalizeNotebookObject({id:'shape',type:'rect',x:NaN}),{code:'notebook_number'});
  assert.throws(()=>normalizeNotebookObject({id:'shape',type:'rect',fill:'url(https://example.invalid)'}),{code:'notebook_color'});
  assert.throws(()=>normalizeNotebookObject({id:'shape',type:'script'}),{code:'notebook_object'});
  assert.throws(()=>normalizeNotebookObject({id:'shape',type:'image',asset:'https://example.invalid/a.png'}),{code:'notebook_asset'});
  assert.throws(()=>normalizeNotebookObject({id:'shape',type:'text',text:'x'.repeat(100001)}),{code:'notebook_text'});
  assert.throws(()=>normalizeNotebookObject({id:'shape',type:'ink',points:[]}),{code:'notebook_points'});
  assert.throws(()=>applyNotebookEdits(scene(),{},[put('shape'),put('shape')],human),{code:'notebook_edit'});
});
test('document validation requires object identities, revisions and complete assets', () => {
  const valid=applyNotebookEdits(scene(),{},[put('shape')],human).document;
  assert.deepEqual(normalizeNotebookDocument(valid),valid);
  assert.throws(()=>normalizeNotebookDocument({...valid,objects:[...valid.objects,...valid.objects]}),{code:'notebook_object'});
  assert.throws(()=>normalizeNotebookDocument({...valid,objects:[{...valid.objects[0],revision:0}]}),{code:'notebook_revision'});
  assert.throws(()=>normalizeNotebookDocument({...valid,objects:[{...valid.objects[0],type:'image',asset:'a'.repeat(64)}]}),{code:'notebook_asset'});
});
