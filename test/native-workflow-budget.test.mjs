import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,statSync,renameSync} from 'node:fs';
import path from 'node:path';
import {nativeWorkflowBudget,nativeMcpRequestOptions,waitNativeOperation,createNativeDeviceSnapshot} from '../src/native-workflow-budget.js';
import {temp} from './helpers.mjs';

test('native duration remains Python-authorized D with separate bounded startup/cleanup/client envelopes',()=>{
 const b=nativeWorkflowBudget({limits:{maxDurationMs:480000}});
 assert.deepEqual(b,{durationMs:480000,startupGraceMs:10000,timeoutMs:490000,cleanupGraceMs:12000,clientGraceMs:10000,clientTimeoutMs:512000});
 assert(Object.isFrozen(b));assert.equal(nativeWorkflowBudget({}).durationMs,60000);
 assert.equal(nativeWorkflowBudget({limits:{maxDurationMs:1}}).timeoutMs,10001);
 assert.equal(nativeWorkflowBudget({limits:{maxDurationMs:3600000}}).clientTimeoutMs,3632000);
 for(const value of [0,-1,3600001,1.1,true,false,null,'480000',NaN,Infinity])assert.throws(()=>nativeWorkflowBudget({limits:{maxDurationMs:value}}),{code:'NATIVE_BUDGET_INVALID'});
 for(const limits of [null,[],false,42])assert.throws(()=>nativeWorkflowBudget({limits}),{code:'NATIVE_BUDGET_INVALID'});
});

test('private per-run snapshots retain exact values and cwd semantics, not later original-file budget changes',t=>{
 const dir=temp(t),file=path.join(dir,'device.json'),dc={limits:{maxDurationMs:480000},backend:{adb:'./relative-adb'},unchanged:['../same-value']};
 writeFileSync(file,JSON.stringify(dc));
 const snapshot=createNativeDeviceSnapshot(JSON.parse(readFileSync(file)),path.join(dir,'private'));
 const other=createNativeDeviceSnapshot(dc,path.join(dir,'private'));
 assert.notEqual(snapshot.path,other.path);assert.equal(statSync(snapshot.path).mode&0o777,0o600);
 dc.limits.maxDurationMs=3600000;writeFileSync(file,JSON.stringify(dc));
 assert.equal(snapshot.budget.durationMs,480000);assert.equal(JSON.parse(readFileSync(snapshot.path)).limits.maxDurationMs,480000);
 assert.equal(JSON.parse(readFileSync(snapshot.path)).backend.adb,'./relative-adb');
 snapshot.dispose();snapshot.dispose();assert(!existsSync(snapshot.path));assert(existsSync(other.path));other.dispose();
});

test('snapshot cleanup never deletes a replacement object at the owned filename',t=>{
 const dir=temp(t),snapshot=createNativeDeviceSnapshot({},dir);renameSync(snapshot.path,snapshot.path+'.original');writeFileSync(snapshot.path,'replacement');
 assert.throws(()=>snapshot.dispose(),{code:'NATIVE_CONFIG_SNAPSHOT_CHANGED'});assert.equal(readFileSync(snapshot.path,'utf8'),'replacement');
});

test('polling can outlive the old300s cutoff but consumes one monotonically shrinking deadline',async()=>{
 const budget=nativeWorkflowBudget({limits:{maxDurationMs:480000}}),options=[];let clock=0;
 const result=await waitNativeOperation(async opts=>{options.push(opts);if(options.length===1){clock=300100;return {status:'running'}}return {status:'completed'};},budget,{now:()=>clock,sleep:async ms=>{clock+=ms}});
 assert.equal(result.status,'completed');assert.equal(options.length,2);assert.equal(options[0].timeout,512000);assert.equal(options[1].timeout,211400);
 assert(options.every(o=>o.maxTotalTimeout===o.timeout&&!o.resetTimeoutOnProgress));
});

test('late terminal replies and deadline exhaustion are not success or fresh timeout resets',async()=>{
 const budget=nativeWorkflowBudget({limits:{maxDurationMs:1}});let clock=0,calls=0;
 await assert.rejects(waitNativeOperation(async()=>{calls++;clock=budget.clientTimeoutMs;return {status:'completed'};},budget,{now:()=>clock,sleep:async()=>{}}),{code:'NATIVE_CLIENT_DEADLINE'});assert.equal(calls,1);
 assert.throws(()=>nativeMcpRequestOptions(budget,0),{code:'NATIVE_CLIENT_DEADLINE'});
 assert.throws(()=>nativeMcpRequestOptions({clientTimeoutMs:Infinity}),{code:'NATIVE_CLIENT_DEADLINE'});
});

test('abort during a pending read reaches the same SDK request signal and settles without another poll',async()=>{
 const controller=new AbortController(),budget=nativeWorkflowBudget({});let called=0,cancelled=0;
 const waiting=waitNativeOperation(options=>{called++;assert.equal(options.signal,controller.signal);return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>{cancelled++;reject(options.signal.reason)},{once:true});queueMicrotask(()=>controller.abort(new Error('cancel-during-read')));});},budget,{signal:controller.signal});
 await assert.rejects(waiting,/cancel-during-read/);assert.equal(called,1);assert.equal(cancelled,1);
});
