import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeDialogs } from '../src/dialogs.js';
import { clickElement, gotoStep } from '../src/replay.js';
import { createBudget } from '../src/budget.js';

const elapsed=async fn=>{const started=performance.now();const result=await fn();return {result,ms:performance.now()-started};};
const settings={quietMs:20,settleMs:20,timeoutMs:1500};

test('unchanged generation reuses its completed observation window',async()=>{
  const page=new EventEmitter(),dialogs=makeDialogs(page,{stabilize:settings});
  try{
    const first=await elapsed(()=>dialogs.stabilize());
    const second=await elapsed(()=>dialogs.stabilize());
    assert.equal(first.result.stable,true);assert.ok(first.ms>=35);
    assert.equal(second.result.cached,true);assert.ok(second.ms<30,`cached wait: ${second.ms}ms`);
    dialogs.invalidate();
    const third=await elapsed(()=>dialogs.stabilize());
    assert.equal(third.result.cached,false);assert.ok(third.ms>=35);
  }finally{dialogs.dispose();}
});

test('short respects a configured timeout below 400ms and caches timeout honestly',async()=>{
  const page=new EventEmitter(),dialogs=makeDialogs(page,{stabilize:{quietMs:10,settleMs:0,timeoutMs:100}});
  try{
    page.emit('request',{});
    const first=await elapsed(()=>dialogs.stabilize(true));
    assert.equal(first.result.stable,false);assert.equal(first.result.timedOut,true);
    assert.ok(first.ms>=90&&first.ms<250,`short timeout: ${first.ms}ms`);
    const next=await dialogs.stabilize();assert.equal(next.cached,true);assert.equal(next.stable,false);assert.equal(next.timedOut,true);
  }finally{dialogs.dispose();}
});

test('network and frame events invalidate cached stability',async()=>{
  const page=new EventEmitter(),dialogs=makeDialogs(page,{stabilize:settings});
  try{
    await dialogs.stabilize();
    const request={};page.emit('request',request);page.emit('requestfinished',request);
    assert.equal((await dialogs.stabilize()).cached,false);
    page.emit('framenavigated',{});assert.equal((await dialogs.stabilize()).cached,false);
  }finally{dialogs.dispose();}
});

test('DOM activity after 120ms restarts the default observation window',async()=>{
  const page=new EventEmitter();let revision=0,lastActivity=Date.now();
  page.frames=()=>[page];page.evaluate=async fn=>fn.name==='observeDom'?{instance:'mock-document',revision,lastActivity}:undefined;
  const dialogs=makeDialogs(page,{});
  const timer=setTimeout(()=>{revision++;lastActivity=Date.now();},120);
  try{
    const first=await elapsed(()=>dialogs.stabilize());
    assert.equal(first.result.stable,true);assert.ok(first.ms>=260,`late DOM: ${first.ms}ms`);
    assert.equal((await dialogs.stabilize()).cached,true);
    revision++;lastActivity=Date.now();assert.equal((await dialogs.stabilize()).cached,false);
  }finally{clearTimeout(timer);dialogs.dispose();}
});

test('STOP interrupts the observation window through the shared budget',async()=>{
  const outputDir=mkdtempSync(path.join(tmpdir(),'bfs-wait-stop-'));
  const config={outputDir,maxDurationMs:5000,stabilize:{quietMs:1000,settleMs:1000,timeoutMs:4000}};
  const budget=createBudget(config,{emit:()=>{},checkpoint:null});config._runtime={budget};
  const page=new EventEmitter(),dialogs=makeDialogs(page,config);
  const timer=setTimeout(()=>writeFileSync(path.join(outputDir,'STOP'),''),30);
  try{
    const started=performance.now();await assert.rejects(()=>dialogs.stabilize(),error=>error.reason==='STOP');
    assert.ok(performance.now()-started<300);
  }finally{clearTimeout(timer);dialogs.dispose();budget.dispose();rmSync(outputDir,{recursive:true,force:true});}
});

test('native dialogs remain dismissed and mark the current action',async()=>{
  const page=new EventEmitter(),events=[],runtime={currentActionId:'test-action'};
  runtime.emit=(...args)=>events.push(args);
  const dialogs=makeDialogs(page,{_runtime:runtime});let dismissed=false;
  try{
    page.emit('dialog',{type:()=> 'confirm',message:()=> 'Continue?',dismiss:async()=>{dismissed=true;}});
    assert.equal(dismissed,true);assert.equal(runtime.dialogRejected,true);assert.equal(dialogs.rejections,1);
    assert.equal(events[0][0],'native_dialog');assert.equal(events[0][1].actionId,'test-action');
  }finally{dialogs.dispose();}
});

test('clickElement and gotoStep invalidate before executing actions',async()=>{
  const calls=[],locator={count:async()=>1,evaluate:async()=>({excluded:false,text:'View',href:'',htmlType:'',formAction:null}),click:async()=>calls.push('click')};
  const page={locator:()=>locator,goto:async()=>{calls.push('goto');return null;}};
  const dialogs={invalidate:()=>calls.push('invalidate'),handle:async()=>{},stabilize:async()=>calls.push('stabilize')};
  await clickElement(page,dialogs,{selector:'#view',label:'View',type:'click'},{actionTimeoutMs:100});
  assert.deepEqual(calls,['invalidate','click','stabilize']);calls.length=0;
  await gotoStep(page,dialogs,'http://127.0.0.1/',{});assert.deepEqual(calls,['invalidate','goto','stabilize']);
});


test('STOP is checked even when the previous generation is already cached',async()=>{
  const outputDir=mkdtempSync(path.join(tmpdir(),'bfs-wait-cached-stop-'));
  const config={outputDir,maxDurationMs:5000,stabilize:{quietMs:0,settleMs:0,timeoutMs:100}};
  const budget=createBudget(config,{emit:()=>{},checkpoint:null});config._runtime={budget};
  const page=new EventEmitter(),dialogs=makeDialogs(page,config);
  try{
    await dialogs.stabilize();assert.equal((await dialogs.stabilize()).cached,true);
    writeFileSync(path.join(outputDir,'STOP'),'');await assert.rejects(()=>dialogs.stabilize(),error=>error.reason==='STOP');
  }finally{dialogs.dispose();budget.dispose();rmSync(outputDir,{recursive:true,force:true});}
});

test('dispose removes all page event listeners and prevents a fresh wait',async()=>{
  const page=new EventEmitter(),dialogs=makeDialogs(page,{stabilize:settings});
  assert.ok(page.listenerCount('request')>0);dialogs.dispose();
  for(const name of ['request','requestfinished','requestfailed','dialog','framenavigated','frameattached','framedetached'])assert.equal(page.listenerCount(name),0);
  assert.equal((await dialogs.stabilize()).disposed,true);
});
