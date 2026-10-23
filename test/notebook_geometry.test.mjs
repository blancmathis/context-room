import test from 'node:test';
import assert from 'node:assert/strict';
import {notebookObjectBounds, notebookHit, translateNotebookObject, notebookSceneBounds, pointInPolygon} from '../src/notebook_geometry.mjs';
test('geometry handles pressure, negative extents, lasso and movement without changing samples',()=>{
 const ink={id:'ink',type:'ink',points:[[1,2,.3,10],[80,2,.8,30]],strokeWidth:4};
 assert.equal(notebookHit({objects:[ink]},[40,3])?.id,'ink');
 assert.equal(notebookHit({objects:[ink]},[40,20]),null);
 assert.deepEqual(translateNotebookObject(ink,5,-3).points,[[6,-1,.3,10],[85,-1,.8,30]]);
 assert.deepEqual(ink.points,[[1,2,.3,10],[80,2,.8,30]]);
 const b=notebookObjectBounds({id:'r',type:'rect',x:100,y:100,width:-40,height:-20,strokeWidth:2});
 assert.deepEqual(b,{x:59,y:79,width:42,height:22});
 assert.equal(pointInPolygon([1,1],[[0,0],[2,0],[2,2],[0,2]]),true);
 assert.equal(pointInPolygon([3,1],[[0,0],[2,0],[2,2],[0,2]]),false);
});
test('connectors follow object IDs and object bounds include rotations',()=>{
 const a={id:'a',type:'rect',x:0,y:0,width:100,height:50}, b={id:'b',type:'rect',x:200,y:0,width:100,height:50};
 const connector={id:'c',type:'connector',from:'a',to:'b'};
 assert.deepEqual(notebookObjectBounds(connector,[a,b]),{x:49,y:24,width:202,height:2});
 const rotated=notebookObjectBounds({...a,rotation:90});
 assert.equal(Math.round(rotated.width),52);assert.equal(Math.round(rotated.height),102);
 const overall=notebookSceneBounds({objects:[a,b,connector]});assert.ok(overall.width>=300);assert.ok(overall.height>=50);
});
import {notebookAgentChanges, notebookFollowViewport} from '../src/notebook_geometry.mjs';
const boxFor=(id,x,kind='agent',revision=1)=>({id,type:'rect',x,y:0,width:100,height:100,strokeWidth:0,revision,updatedBy:{kind}});
test('agent changes ignore human edits and the first render',()=>{
 assert.equal(notebookAgentChanges(null,{objects:[boxFor('a',0)]}),null);
 const previous={objects:[boxFor('a',0),boxFor('h',200,'human')]};
 assert.equal(notebookAgentChanges(previous,previous),null);
 assert.equal(notebookAgentChanges(previous,{objects:[boxFor('a',0),boxFor('h',900,'human',2)]}),null);
 assert.deepEqual(notebookAgentChanges(previous,{objects:[...previous.objects,boxFor('n',5000),boxFor('m',6000,'agent')]}),{x:4999,y:-1,width:1102,height:102});
 assert.deepEqual(notebookAgentChanges(previous,{objects:[boxFor('a',0,'agent',2),previous.objects[1]]}),{x:-1,y:-1,width:102,height:102});
 assert.deepEqual(notebookAgentChanges(previous,{objects:[previous.objects[1]]}),{x:-1,y:-1,width:102,height:102});
});
test('follow viewport pans at the current scale, zooms out only when needed, never zooms in',()=>{
 const view={x:0,y:0,scale:2,width:800,height:600};
 assert.deepEqual(notebookFollowViewport(view,{x:5000,y:100,width:100,height:100}),{x:400-5050*2,y:300-150*2,scale:2});
 const out=notebookFollowViewport(view,{x:5000,y:0,width:2000,height:100});
 assert.equal(out.scale,800*.9/2000); assert.ok(out.scale<2);
 assert.equal(notebookFollowViewport({...view,scale:.1},{x:50000,y:0,width:10,height:10}).scale,.1);
 assert.equal(notebookFollowViewport(view,{x:5000,y:0,width:1e9,height:1}).scale,.05);
 assert.equal(notebookFollowViewport({...view,scale:20},{x:5000,y:100,width:1,height:1}).scale,20);
});
test('no reframe when the change is visible',()=>{
 assert.equal(notebookFollowViewport({x:0,y:0,scale:1,width:800,height:600},{x:10,y:10,width:100,height:100}),null);
 assert.notEqual(notebookFollowViewport({x:0,y:0,scale:1,width:800,height:600},{x:750,y:10,width:100,height:100}),null);
});
