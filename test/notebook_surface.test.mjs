import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { NotebookCanvas } from '../src/ui/notebook-canvas.mjs';
import { NotebookClient, MemoryNotebookStorage } from '../src/notebook_client.mjs';
import { emptyNotebook, applyNotebookEdits } from '../src/notebook_protocol.mjs';
import { notebookImageSize } from '../src/notebook_images.mjs';
import { notebookBounds, notebookSvg } from '../src/notebook_render.mjs';
import { contextRoomWebAssetBundle } from '../src/context_room.mjs';
import { NOTEBOOK_WEB_ASSETS } from '../src/notebook_web_assets.mjs';

async function surfaceFixture(t) {
  const previous = Object.fromEntries(['ResizeObserver','requestAnimationFrame','cancelAnimationFrame'].map(key=>[key,globalThis[key]]));
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }; globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
  t.after(()=>{ surface.dispose(); for(const [key,value] of Object.entries(previous)) if(value === undefined)delete globalThis[key];else globalThis[key]=value; });
  const canvas = new EventTarget(), captures = new Set(), errors = [];
  Object.assign(canvas, { style: {}, focus() {}, getBoundingClientRect: () => ({x:0,y:0,left:0,top:0,width:1000,height:800}), setPointerCapture: id=>captures.add(id), hasPointerCapture: id=>captures.has(id), releasePointerCapture: id=>captures.delete(id) });
  const client = new NotebookClient({ storage: new MemoryNotebookStorage(), transport: {}, scope: { serverId: 'synthetic-server', accountId:'synthetic-human',deviceId:'synthetic-browser',resourceId:'synthetic-board' }, actor:{ kind:'human', id:'synthetic-human' } });
  const surface = new NotebookCanvas(canvas, { enqueue:(...args)=>client.enqueue(...args), onError:error=>errors.push(error) });
  client.onChange = snapshot=>surface.setDocument(snapshot.document);
  await client.initialize({protocolVersion:1,resourceId:'synthetic-board',document:emptyNotebook('synthetic-board'),locator:{path:'docs/Sketch.crnb',revision:'location-1'},revision:0,sequence:0,tombstones:{}});
  const event = (pointerId,x,y,pointerType='pen',pressure=.5) => ({pointerId,clientX:x,clientY:y,pointerType,pressure,button:0,preventDefault(){}});
  return { surface, client, event, errors };
}

test('portable canvas contract persists a moving pressure pen, rejects touch ink and retains incoming changes independently (not browser/physical proof)', async t=>{
  const {surface,client,event,errors}=await surfaceFixture(t);
  surface.down(event(1,80,90)); surface.move(event(1,90,110,'pen',.9)); await Promise.all([...surface.tasks]);
  assert.equal(surface.gesture.kind,'ink'); assert.equal((await client.view()).document.objects[0].points.length,2);
  surface.down(event(2,400,450,'touch')); surface.move(event(2,480,470,'touch')); surface.up(event(2,480,470,'touch'));
  assert.equal(surface.gesture.kind,'ink'); assert.equal(surface.pointers.size,1);
  const state = await client.state(); const applied=applyNotebookEdits(state.snapshot.document,{},[{kind:'put',id:'agent',expectedRevision:0,object:{id:'agent',type:'rect',x:600,y:400}}],{kind:'agent',id:'synthetic-agent'});
  await client.adopt({...state.snapshot,document:applied.document,revision:1,sequence:1});await client.notify();
  assert.equal(surface.gesture.kind,'ink'); assert.equal(surface.document.objects.length,2);
  await surface.settle(); assert.equal(surface.gesture,null); assert.equal(surface.pointers.size,0);
  await client.replayGesture('undo'); assert.deepEqual((await client.view()).document.objects.map(o=>o.id),['agent']); assert.deepEqual(errors,[]);
});

test('a transform compares its pointer-down revision and does not replace a newer remote object',async t=>{
  const {surface,client,event,errors}=await surfaceFixture(t);
  await client.enqueue([{kind:'put',id:'rectangle',expectedRevision:0,object:{id:'rectangle',type:'rect',x:100,y:100,width:80,height:80}}]);
  surface.setTool('select');surface.down(event(1,145,145));surface.move(event(1,175,175));
  assert.equal(surface.gesture.kind,'transform');
  await client.enqueue([{kind:'patch',id:'rectangle',expectedRevision:1,patch:{x:250}}]);
  surface.up(event(1,175,175));await surface.settle();
  assert.equal((await client.view()).document.objects[0].x,250);assert.equal((await client.view()).conflicts.length,1); assert.equal((await client.view()).conflicts[0].error.code,'notebook_object_conflict'); assert.deepEqual(errors,[]);
});

test('back-to-back strokes retain their lift coordinates and separate undo while storage is delayed', async t => {
  const { surface, client, event, errors } = await surfaceFixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  surface.enqueue = async (...args) => { await gate; return client.enqueue(...args); };
  surface.down(event(1, 50, 50)); surface.move(event(1, 100, 100)); surface.up(event(1, 150, 150));
  surface.down(event(2, 250, 100));
  assert.equal(surface.gesture.pointerId, 2, 'a saving gesture cannot consume the next pen-down');
  surface.move(event(2, 300, 150)); surface.up(event(2, 350, 200));
  assert.equal(surface.gesture, null);
  assert.equal(surface.finishingStrokes.size, 2, 'unsaved previews remain visible');
  assert.equal((await client.view()).document.objects.length, 0);
  release(); await surface.settle();
  const objects = (await client.view()).document.objects;
  assert.equal(objects.length, 2);
  assert.deepEqual(objects.map(object => object.points.at(-1)), [[118, 118, .5], [318, 168, .5]]);
  assert.equal((await client.state()).metadata.gestureHistory.undo.length, 2);
  await client.replayGesture('undo');
  assert.deepEqual((await client.view()).document.objects.map(object => object.id), [objects[0].id]);
  await client.replayGesture('undo'); assert.equal((await client.view()).document.objects.length, 0);
  assert.equal(surface.finishingStrokes.size, 0); assert.deepEqual(errors, []);
});

test('pen lift finishes shape geometry but cancellation does not invent a new ink point', async t => {
  const { surface, client, event, errors } = await surfaceFixture(t);
  surface.setTool('rect'); surface.down(event(1, 50, 50)); surface.up(event(1, 150, 160)); await surface.settle();
  const shape = (await client.view()).document.objects[0];
  assert.deepEqual([shape.x, shape.y, shape.width, shape.height], [18, 18, 100, 110]);
  surface.setTool('ink'); surface.down(event(2, 100, 100)); surface.move(event(2, 120, 120));
  surface.up({ ...event(2, 900, 900), type: 'pointercancel' }); await surface.settle();
  const ink = (await client.view()).document.objects.find(object => object.type === 'ink');
  assert.deepEqual(ink.points, [[68, 68, .5], [88, 88, .5]]); assert.deepEqual(errors, []);
});

test('changing tools while a stroke saves preserves whole-gesture undo order', async t => {
  const { surface, client, event } = await surfaceFixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  surface.enqueue = async (...args) => { await gate; return client.enqueue(...args); };
  surface.down(event(1, 50, 50)); surface.move(event(1, 100, 100)); surface.up(event(1, 150, 150));
  surface.setTool('rect'); surface.down(event(2, 250, 100)); surface.up(event(2, 350, 200));
  release(); await surface.settle();
  assert.deepEqual((await client.view()).document.objects.map(object => object.type), ['ink', 'rect']);
  await client.replayGesture('undo');
  assert.deepEqual((await client.view()).document.objects.map(object => object.type), ['ink']);
  await client.replayGesture('undo'); assert.equal((await client.view()).document.objects.length, 0);
});

test('consecutive failed saves retain every stroke recovery suffix', async t => {
  const { surface, event, errors } = await surfaceFixture(t);
  surface.enqueue = async () => { throw new Error('Synthetic storage unavailable'); };
  surface.down(event(1, 50, 50)); surface.up(event(1, 100, 100));
  surface.down(event(2, 150, 150)); surface.up(event(2, 200, 200));
  await surface.settle();
  assert.equal(surface.failedStrokes.length, 2);
  assert.deepEqual(surface.failedStrokes.map(stroke => stroke.unsavedSamples.flat().at(-1)), [[68, 68, .5], [168, 168, .5]]);
  assert.ok(errors.every(error => error.message === 'Synthetic storage unavailable'));
});

test('touch navigation and keyboard selection do not rewrite the scene or another object',async t=>{
  const {surface,client,event,errors}=await surfaceFixture(t);
  surface.down(event(1,60,80,'touch'));surface.move(event(1,120,150,'touch'));surface.up(event(1,120,150,'touch'));
  assert.equal((await client.view()).document.objects.length,0);assert.equal(surface.view.x,92);
  await client.enqueue(['one','two'].map((id,index)=>({kind:'put',id,expectedRevision:0,object:{id,type:'text',x:index*100,y:100,text:id}})));
  surface.select(['one']);await surface.moveSelection(10,20);assert.deepEqual((await client.view()).document.objects.map(o=>[o.id,o.x,o.y]),[['one',10,120],['two',100,100]]);
  assert.deepEqual(errors,[]);
});

test('shipped notebook assets are explicit portable modules and the generated application script parses',()=>{
  const bundle=contextRoomWebAssetBundle(); new vm.Script(bundle.js);
  assert.match(bundle.js,/function captureNotebookApi/);assert.match(bundle.js,/data-context-notebook/);
  for(const [url,entry] of NOTEBOOK_WEB_ASSETS){assert.equal(url.startsWith('/assets/'),true);assert.equal(fs.existsSync(new URL('../src/'+entry.file,import.meta.url)),true);assert.doesNotMatch(entry.file,/notebooks[.]mjs|notebook_io|context_room|\.\.\//);}
  assert.equal(NOTEBOOK_WEB_ASSETS.has('/assets/../notebook_io.mjs'),false);
});

test('image headers are bounded before native/browser decode; truncated or oversized assets are retained as failures',()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y2uoAAAAASUVORK5CYII=','base64');
  assert.deepEqual(notebookImageSize(png,'image/png'),{width:1,height:1});
  const big=Buffer.from(png);big.writeUInt32BE(100000,16);big.writeUInt32BE(100000,20);assert.throws(()=>notebookImageSize(big,'image/png'),{code:'notebook_image_size'});
  assert.throws(()=>notebookImageSize(png.subarray(0,20),'image/png'),{code:'notebook_asset'});
  assert.throws(()=>notebookImageSize(png,'image/jpeg'),{code:'notebook_asset'});
  assert.match(notebookSvg(emptyNotebook('synthetic-board')),new RegExp('viewBox="0 0 '+notebookBounds(emptyNotebook('synthetic-board')).width+' '));
});
