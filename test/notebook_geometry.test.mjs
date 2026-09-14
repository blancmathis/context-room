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
