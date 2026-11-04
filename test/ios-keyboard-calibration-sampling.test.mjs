// Synthetic PNG + readonly injected transport. No device, HTTP server or OCR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync,realpathSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {PNG} from 'pngjs';
import {sampleOwnerKeyboardCalibration,CALIBRATION_SAMPLING} from './ios-keyboard-calibration-sampling.mjs';
import {approvedKeyboardEnvelope} from './ios-keyboard-envelope.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const geometry={x:0,y:0,width:100,height:200},appId='com.example.calibration';
const valueRegion={x:.1,y:.1,width:.8,height:.2},resultRegion={x:.1,y:.35,width:.8,height:.1};
const proposal={region:{x:0,y:.65,width:1,height:.25},keyCount:1};
const approval={appId,visualEnvelope:{x:0,y:125,width:100,height:75}};
const caretPolicy={enabled:true,color:[66,107,242],background:[255,255,255],colorTolerance:2,
 maxWidthPoints:3,minHeightPoints:8,maxHeightPoints:48,maxAreaPoints:144};
const source='<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" bundleId="'+appId+'" visible="true" enabled="true" x="0" y="0" width="100" height="200"><XCUIElementTypeWindow type="XCUIElementTypeWindow" visible="true" x="0" y="0" width="100" height="200"><XCUIElementTypeKeyboard type="XCUIElementTypeKeyboard" visible="true" x="0" y="130" width="100" height="50"><XCUIElementTypeKey type="XCUIElementTypeKey" name="a" label="a" visible="true" enabled="true" x="10" y="140" width="10" height="20"/></XCUIElementTypeKeyboard></XCUIElementTypeWindow></XCUIElementTypeApplication></AppiumAUT>';
function fixture(t,{frames=['bright','off'],mutateRead,mutateParse,beforeEdit,signal}={}){
 const output=mkdtempSync(path.join(realpathSync(tmpdir()),'bfs-calibration-sampling-'));t.after(()=>rmSync(output,{recursive:true,force:true}));
 const baseline=new PNG({width:100,height:200});baseline.data.fill(255);beforeEdit?.(baseline);
 const beforePath=path.join(output,'before.png');writeFileSync(beforePath,PNG.sync.write(baseline));
 const png=kind=>{
  if(kind==='bad')return Buffer.from('not PNG').toString('base64');
  if(kind==='nochange')return PNG.sync.write(baseline).toString('base64');
  const image=kind==='dimension'?new PNG({width:100,height:199}):PNG.sync.read(PNG.sync.write(baseline));
  if(kind==='dimension')image.data.fill(255);
  for(let y=125;y<image.height;y++)for(let x=0;x<100;x++)image.data.set([180,180,180,255],(y*100+x)*4);
  const pixel=(x,y,color)=>image.data.set(color,(y*image.width+x)*4);
  if(kind!=='off'&&kind!=='dimension')for(let y=25;y<45;y++)for(let x=20;x<22;x++)pixel(x,y,[66,107,242,255]);
  if(kind==='result')pixel(20,75,[0,0,0,255]);
  if(kind==='other')pixel(2,2,[0,0,0,255]);
  if(kind==='multi')for(let y=25;y<45;y++)for(let x=30;x<32;x++)pixel(x,y,[66,107,242,255]);
  if(kind==='offcolor')pixel(20,25,[200,0,0,255]);
  const encoded=PNG.sync.write(image);if(kind==='crc')encoded[encoded.length-1]^=1;
  return encoded.toString('base64');
 };
 let time=0,captures=0,sourceReads=0,parses=0;const calls=[];
 const read=async(kind,options)=>{
  assert(['app','window','orientation','source','screenshot'].includes(kind),'No action route available');
  assert(options.timeoutMs>0&&options.timeoutMs<=(kind==='source'?4000:1500));assert(options.signal instanceof AbortSignal);
  calls.push(kind);time+=1;let value;
  if(kind==='app')value={bundleId:appId};if(kind==='window')value={...geometry};if(kind==='orientation')value='PORTRAIT';
  if(kind==='source'){sourceReads++;value=source;}
  if(kind==='screenshot'){value=png(frames[Math.min(captures,frames.length-1)]);captures++;}
  return mutateRead?await mutateRead({kind,value,options,calls,captures,sourceReads,advance:ms=>time+=ms}):value;
 };
 const inspectSource=async(file,options)=>{
  assert(options.timeoutMs>0&&options.timeoutMs<=1500);parses++;time+=1;
  const parsed={sourceSha256:hash(readFileSync(file)),appId,proposal:structuredClone(proposal),authorization:false};
  return mutateParse?mutateParse({parsed,parses,file,advance:ms=>time+=ms}):parsed;
 };
 const options={beforePath,output,appId,geometry,orientation:'PORTRAIT',approval,valueRegion,resultRegion,caretPolicy,
  read,inspectSource,signal,clock:{now:()=>time,sleep:async ms=>{assert.equal(ms,125);time+=ms;}}};
 return {options,output,beforePath,calls,get captures(){return captures},get sourceReads(){return sourceReads},
  run:()=>sampleOwnerKeyboardCalibration(options),receipt:()=>JSON.parse(readFileSync(path.join(output,'calibration-sampling.json')))};
}

test('bright caret permits only another read; off candidate passes full original guard using same retained PNG',async t=>{
 const f=fixture(t),before=readFileSync(f.beforePath),result=await f.run();
 assert.equal(result.sampling.status,'passed');assert.equal(result.sampling.acceptedCandidate,2);
 assert.equal(result.sampling.uiActions,0);assert.equal(f.captures,2);assert.equal(f.calls.length,18);assert.equal(f.sourceReads,4);
 assert.deepEqual(f.calls,['app','window','orientation','source','screenshot','source','app','window','orientation',
  'app','window','orientation','source','screenshot','source','app','window','orientation']);
 assert.equal(result.pngPath,path.join(f.output,'calibration-candidate-02.png'));
 assert.equal(hash(readFileSync(result.pngPath)),result.pngSha256);assert.deepEqual(readFileSync(f.beforePath),before);
 assert.throws(()=>approvedKeyboardEnvelope(f.beforePath,path.join(f.output,'calibration-candidate-01.png'),
  {...f.options,sourceRegion:proposal.region,visibleSourcePath:path.join(f.output,'calibration-candidate-01-source-before.xml')}),/CALIBRATION_UNRELATED_PIXELS_CHANGED/);
 const actual=approvedKeyboardEnvelope(f.beforePath,result.pngPath,{...f.options,sourceRegion:proposal.region,visibleSourcePath:result.visibleSourcePath});
 assert.deepEqual(actual,result.envelope);assert.equal(actual.authorization,false);
 for(const file of readdirSync(f.output).filter(p=>p.startsWith('calibration-')))assert.equal(statSync(path.join(f.output,file)).mode&0o777,0o600);
 assert.equal(f.receipt().status,'full_guard_passed_pending_final_deadline');
});

test('all six bright candidates exhaust fixed cap without actions or accepting caret-compatible frame',async t=>{
 const f=fixture(t,{frames:['bright']});await assert.rejects(f.run(),{code:'CALIBRATION_SAMPLING_EXHAUSTED'});
 assert.equal(f.captures,6);assert.equal(f.calls.length,54);assert.equal(f.sourceReads,12);
 assert.equal(readdirSync(f.output).filter(p=>/candidate-\d+\.png$/.test(p)).length,6);
 const receipt=f.receipt();assert.equal(receipt.status,'failed');assert.equal(receipt.uiActions,0);assert.equal(receipt.acceptedCandidate,null);
 assert(receipt.candidates.every(r=>r.status==='strict_envelope_rejected_caret_compatible_readonly_resample'));
});

test('early timer wake cannot shorten the minimum125ms readonly interval',async t=>{
 const f=fixture(t),now=f.options.clock.now,waits=[];let offset=0;
 f.options.clock={now:()=>now()+offset,sleep:async ms=>{waits.push(ms);offset+=waits.length===1?ms-1:ms;}};
 const result=await f.run();assert.equal(result.sampling.status,'passed');assert.deepEqual(waits,[125,1]);assert.equal(f.captures,2);
});

for(const kind of ['result','other','multi','offcolor','dimension','bad','nochange','crc'])test('terminal '+kind+' pixels/representation never authorize resampling',async t=>{
 const f=fixture(t,{frames:[kind,'off']});await assert.rejects(f.run());assert.equal(f.captures,1);
 assert.equal(f.receipt().status,'failed');assert.equal(f.receipt().uiActions,0);
});

test('gray underlay is not calibration authority even though key-freshness opt-in exists',async t=>{
 const f=fixture(t,{frames:['bright','off'],beforeEdit:image=>image.data.set([171,171,171,255],(25*100+20)*4)});
 await assert.rejects(f.run(),/CALIBRATION_UNRELATED_PIXELS_CHANGED/);assert.equal(f.captures,1);
 const invalid=fixture(t);invalid.options.caretPolicy={...caretPolicy,underlay:{mode:'paired_revealed_grayscale',maxUnderlayPixels:16,minWhiteCoreFraction:.8,minSharedOpacity:.125}};
 await assert.rejects(invalid.run(),{code:'CALIBRATION_SAMPLING_CONFIG_INVALID'});assert.deepEqual(invalid.calls,[]);
});

for(const change of ['app','window','orientation','source','plane'])test('changed '+change+' identity stops without another screenshot or action',async t=>{
 const f=fixture(t,{frames:['bright','off'],mutateRead:({kind,value,sourceReads,captures})=>{
  if(change==='source'&&kind==='source'&&sourceReads===2)return value+' ';
  if(change===kind&&captures===1){if(kind==='app')return{bundleId:'com.example.foreign'};if(kind==='window')return{...geometry,width:101};if(kind==='orientation')return'LANDSCAPE';}
  return value;
 },mutateParse:({parsed,parses})=>{if(change==='plane'&&parses===2)parsed.proposal.region.y=.66;return parsed;}});
 await assert.rejects(f.run());assert.equal(f.captures,1);assert.equal(f.receipt().status,'failed');
});

test('source/layout identity cannot change between separately stable candidate pairs',async t=>{
 const f=fixture(t,{frames:['bright','off'],mutateRead:({kind,value,sourceReads})=>kind==='source'&&sourceReads>=3?value+' ':value});
 await assert.rejects(f.run(),{code:'CALIBRATION_SOURCE_CHANGED'});assert.equal(f.captures,1);
});

test('per-request timeout refuses a late successful reply, with no retry',async t=>{
 const f=fixture(t,{mutateRead:({value,advance})=>{advance(1500);return value;}});
 await assert.rejects(f.run(),{code:'CALIBRATION_SAMPLING_REQUEST_TIMEOUT'});assert.deepEqual(f.calls,['app']);assert.equal(f.captures,0);
});

test('total12s is a completion deadline; slow successful observations cannot open another interval',async t=>{
 const f=fixture(t,{mutateRead:({value,advance})=>{advance(1000);return value;}});
 await assert.rejects(f.run(),{code:'CALIBRATION_SAMPLING_DEADLINE'});assert.equal(f.captures,1);
 assert(f.receipt().elapsedMs>=12000);assert.equal(f.receipt().uiActions,0);
});

test('a full-guard-compatible off frame arriving after total deadline is never accepted',async t=>{
 const f=fixture(t,{frames:['off'],mutateRead:({value,advance})=>{advance(1000);return value;},
  mutateParse:({parsed,advance})=>{advance(1498);return parsed;}});
 await assert.rejects(f.run(),{code:'CALIBRATION_SAMPLING_DEADLINE'});assert.equal(f.captures,1);
 assert.equal(f.receipt().acceptedCandidate,null);assert.equal(f.receipt().status,'failed');
});

test('cancellation aborts observation and never proceeds to screenshot or UI actions',async t=>{
 const controller=new AbortController();let childSignal;
 const f=fixture(t,{signal:controller.signal,mutateRead:({value,options})=>{childSignal=options.signal;controller.abort();return value;}});
 await assert.rejects(f.run(),{code:'CALIBRATION_SAMPLING_CANCELLED'});assert(childSignal.aborted);assert.deepEqual(f.calls,['app']);assert.equal(f.captures,0);
});

test('unknown observer/parse errors do not use caret retry or new baseline',async t=>{
 const f=fixture(t,{mutateRead:({kind,value})=>{if(kind==='source')throw Error('opaque source failure');return value;}});
 await assert.rejects(f.run(),/opaque source failure/);assert.equal(f.captures,0);
 const parsed=fixture(t,{mutateParse:()=>{throw Error('source parse failure');}});await assert.rejects(parsed.run(),/source parse failure/);assert.equal(parsed.captures,0);
});

test('already present candidate artifacts are refused and never overwritten',async t=>{
 const f=fixture(t),file=path.join(f.output,'calibration-candidate-01-source-before.xml');writeFileSync(file,'immutable earlier evidence');
 await assert.rejects(f.run(),{code:'EEXIST'});assert.equal(readFileSync(file,'utf8'),'immutable earlier evidence');assert.equal(f.captures,0);
});

test('actual strict parser enforces app, unique keyboard and every source window rectangle',t=>{
 const f=fixture(t),file=path.join(f.output,'inspect.xml'),script=new URL('./ios-keyboard-calibration-inspect.py',import.meta.url);
 const invoke=xml=>{writeFileSync(file,xml);return JSON.parse(execFileSync('python3',[script.pathname,'--source',file,'--width','100','--height','200','--app-id',appId],
  {encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:path.resolve('apk_tools')}}));};
 const result=invoke(source);assert.deepEqual(result.proposal,proposal);assert.equal(result.authorization,false);assert.equal(result.sourceSha256,hash(Buffer.from(source)));
 const hidden='<XCUIElementTypeKeyboard type="XCUIElementTypeKeyboard" visible="false" x="0" y="200" width="100" height="50"/>';
 for(const xml of [source.replace(appId,'com.example.foreign'),source.replace('</XCUIElementTypeWindow>',hidden+'</XCUIElementTypeWindow>'),
  source.replace('Window" visible="true" x="0" y="0" width="100"','Window" visible="true" x="0" y="0" width="101"'),
  source.replace('Application" bundleId','Application" bundleId').replace('visible="true" enabled="true" x="0"','visible="false" enabled="true" x="0"')])assert.throws(()=>invoke(xml));
});

test('readonly limits are fixed and not caller-expanded',()=>{
 assert(Object.isFrozen(CALIBRATION_SAMPLING));assert.deepEqual([CALIBRATION_SAMPLING.maxCandidates,CALIBRATION_SAMPLING.totalMs,CALIBRATION_SAMPLING.requestMs,CALIBRATION_SAMPLING.sourceRequestMs,CALIBRATION_SAMPLING.intervalMs],[6,12000,1500,4000,125]);
});

test('only readonly source transport may finish beyond1500ms within its4000ms cap',async t=>{
 const f=fixture(t,{frames:['off'],mutateRead:({kind,value,options,advance})=>{
  assert.equal(options.timeoutMs,kind==='source'?4000:1500);
  if(kind==='source')advance(1999);return value;
 }});
 const result=await f.run();assert.equal(result.sampling.acceptedCandidate,1);assert.equal(f.sourceReads,2);assert.equal(f.captures,1);
 assert.equal(result.sampling.uiActions,0);assert.equal(result.sampling.perRequestLimitMs,1500);assert.equal(result.sampling.sourceRequestLimitMs,4000);
 assert(result.sampling.elapsedMs<12000);
 for(const row of f.receipt().readonlyRequests)assert.equal(row.timeoutMs,row.kind==='source'?4000:1500);
});

test('source success exactly at4000ms is terminal and cannot open screenshot or another candidate',async t=>{
 const f=fixture(t,{frames:['off'],mutateRead:({kind,value,options,advance})=>{
  if(kind==='source'){assert.equal(options.timeoutMs,4000);advance(options.timeoutMs-1);}return value;
 }});
 await assert.rejects(f.run(),{code:'CALIBRATION_SAMPLING_REQUEST_TIMEOUT'});
 assert.deepEqual(f.calls,['app','window','orientation','source']);assert.equal(f.captures,0);assert.equal(f.sourceReads,1);
 const receipt=f.receipt();assert.equal(receipt.acceptedCandidate,null);assert.equal(receipt.candidates.length,1);assert.equal(receipt.uiActions,0);
});

test('source cap shrinks to remaining total budget and cannot accept an exact deadline reply',async t=>{
 let remainingCap;
 const f=fixture(t,{frames:['bright','off'],mutateRead:({kind,value,sourceReads,options,advance})=>{
  if(kind==='source'&&sourceReads===3){remainingCap=options.timeoutMs;assert(remainingCap>0&&remainingCap<1500);advance(remainingCap-1);}
  else advance(899);return value;
 }});
 await assert.rejects(f.run(),{code:'CALIBRATION_SAMPLING_DEADLINE'});
 const receipt=f.receipt();assert.equal(receipt.elapsedMs,12000);assert.equal(receipt.acceptedCandidate,null);assert.equal(receipt.uiActions,0);
 assert.equal(f.sourceReads,3);assert.equal(f.captures,1);assert.equal(receipt.candidates.length,2);
 assert.equal(receipt.readonlyRequests.at(-1).kind,'source');assert.equal(receipt.readonlyRequests.at(-1).timeoutMs,remainingCap);
});

test('source cap never widens the1500ms strict parser budget',async t=>{
 const f=fixture(t,{frames:['off'],mutateParse:({parsed,advance})=>{advance(1499);return parsed;}});
 await assert.rejects(f.run(),{code:'CALIBRATION_SAMPLING_REQUEST_TIMEOUT'});
 assert.deepEqual(f.calls,['app','window','orientation','source']);assert.equal(f.captures,0);assert.equal(f.sourceReads,1);
 assert.equal(f.receipt().acceptedCandidate,null);assert.equal(f.receipt().uiActions,0);
});

test('cancellation during source aborts and does not retry or capture a screenshot',async t=>{
 const controller=new AbortController();let childSignal;
 const f=fixture(t,{signal:controller.signal,mutateRead:({kind,value,options})=>{
  if(kind==='source'){childSignal=options.signal;controller.abort();}return value;
 }});
 await assert.rejects(f.run(),{code:'CALIBRATION_SAMPLING_CANCELLED'});assert(childSignal.aborted);
 assert.deepEqual(f.calls,['app','window','orientation','source']);assert.equal(f.captures,0);assert.equal(f.receipt().uiActions,0);
});


test('normal and optimized Python both enforce explicit source app/window input guards',t=>{
 const f=fixture(t),script=new URL('./ios-keyboard-calibration-inspect.py',import.meta.url);
 const invalid=[
  source.replace('Window" visible="true" x="0" y="0" width="100"','Window" visible="true" x="0" y="0" width="101"'),
  source.replace('visible="true" enabled="true" x="0"','visible="false" enabled="true" x="0"'),
  source.replace('visible="true" enabled="true" x="0"','visible="true" enabled="false" x="0"'),
  source.replace('<XCUIElementTypeWindow type="XCUIElementTypeWindow" visible="true" x="0" y="0" width="100" height="200">','').replace('</XCUIElementTypeWindow>',''),
 ];
 for(const optimize of ['0','1']){
  const invoke=(xml,name)=>{const file=path.join(f.output,'optimization-'+optimize+'-'+name+'.xml');writeFileSync(file,xml,{flag:'wx',mode:0o600});return JSON.parse(execFileSync('python3',[script.pathname,'--source',file,'--width','100','--height','200','--app-id',appId],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONOPTIMIZE:optimize,PYTHONPATH:path.resolve('apk_tools')}}));};
  assert.deepEqual(invoke(source,'valid').proposal,proposal);
  for(const [index,xml] of invalid.entries())assert.throws(()=>invoke(xml,'invalid-'+index),'PYTHONOPTIMIZE='+optimize+' must reject source case '+index);
 }
});
