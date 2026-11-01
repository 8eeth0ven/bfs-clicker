import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {realpathSync,writeFileSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {PNG} from 'pngjs';
import {temp} from './helpers.mjs';
import {performPixelOperation} from '../src/visual-pixel-task.js';
import {visualPixelFingerprint} from '../src/visual-pixels.js';
import {visualCaretEquivalent} from '../src/visual-caret.js';

const worker=path.resolve('src/visual-pixel-task.js');
const policy={enabled:true,color:[66,107,242],background:[255,255,255],colorTolerance:2,maxWidthPoints:3,minHeightPoints:8,maxHeightPoints:48,maxAreaPoints:144};
const options={masks:[{x:0,y:.5,width:1,height:.5}],valueRegion:{x:.1,y:.1,width:.8,height:.3},geometry:[100,200],policy};
function image(dir,name,color){const png=new PNG({width:100,height:200});png.data.fill(255);if(color)for(let y=30;y<68;y++)for(let x=20;x<22;x++)png.data.set([...color,255],(y*100+x)*4);const file=path.join(dir,name+'.png');writeFileSync(file,PNG.sync.write(png));return file;}
const invoke=raw=>spawnSync(process.execPath,[worker],{input:raw,encoding:'utf8',timeout:2000,maxBuffer:16384});

test('fingerprint/caret operations retain all original valid-image values and reread paths',t=>{
 const dir=realpathSync(temp(t)),before=image(dir,'before'),after=image(dir,'after',policy.color),request={id:1,operation:'fingerprint',path:before,masks:options.masks};
 assert.deepEqual(performPixelOperation(request),visualPixelFingerprint(before,{masks:options.masks}));
 assert.deepEqual(performPixelOperation({id:2,operation:'caret',before,after,options}),visualCaretEquivalent(before,after,options));
 const first=performPixelOperation(request);image(dir,'before',[0,0,0]);assert.notEqual(performPixelOperation(request).sha256,first.sha256);
});
test('operation input is exact, bounded to scope ids and never accepts another route',t=>{
 const dir=realpathSync(temp(t)),file=image(dir,'image');
 for(const request of [{id:true,operation:'fingerprint',path:file,masks:[]},{id:0,operation:'fingerprint',path:file,masks:[]},{id:4,operation:'fingerprint',path:file,masks:[]},{id:1,operation:'decode',path:file,masks:[]},{id:1,operation:'fingerprint',path:file,masks:[],extra:true},{id:1,operation:'caret',before:file,after:file,options,cache:true}])assert.throws(()=>performPixelOperation(request),{code:'VISUAL_PIXEL_TASK_INVALID'});
});
test('one worker handles sequential operations, echoing exact ids without a decode cache',t=>{
 const dir=realpathSync(temp(t)),before=image(dir,'before'),after=image(dir,'after',policy.color);
 const requests=[{id:1,operation:'fingerprint',path:before,masks:[]},{id:2,operation:'fingerprint',path:after,masks:options.masks},{id:3,operation:'caret',before,after,options}];
 const result=invoke(requests.map(x=>JSON.stringify(x)+'\n').join(''));assert.equal(result.status,0,result.stderr);
 const rows=result.stdout.trim().split('\n').map(x=>JSON.parse(x));assert.equal(rows.length,3);
 for(let i=0;i<3;i++)assert.deepEqual(rows[i],{id:i+1,operation:requests[i].operation,ok:true,value:performPixelOperation(requests[i])});
});
test('invalid JSON/UTF8, oversized messages, repeated ids, duplicate keys and unknown operations exit closed',t=>{
 const dir=realpathSync(temp(t)),file=image(dir,'image'),first={id:1,operation:'fingerprint',path:file,masks:[]};
 for(const raw of ['{\n',Buffer.from([0xff,10]),' '.repeat(16385)+'\n',JSON.stringify(first)+'\n'+JSON.stringify(first)+'\n','{"id":1,"id":1,"operation":"fingerprint","path":'+JSON.stringify(file)+',"masks":[]}\n',JSON.stringify({...first,operation:'unknown'})+'\n']){
  const result=invoke(raw);assert.equal(result.status,1);assert.equal(result.signal,null);assert.equal(result.error,undefined);
 }
});
test('FIFO and nonregular paths fail promptly for both original readers used by the worker',t=>{
 const dir=realpathSync(temp(t)),file=image(dir,'image'),fifo=path.join(dir,'fifo');execFileSync('/usr/bin/mkfifo',[fifo]);
 for(const request of [{id:1,operation:'fingerprint',path:fifo,masks:[]},{id:1,operation:'fingerprint',path:dir,masks:[]},{id:1,operation:'caret',before:fifo,after:file,options}]){
  const result=invoke(JSON.stringify(request)+'\n');assert.equal(result.status,1);assert.equal(result.error,undefined);
 }
});
