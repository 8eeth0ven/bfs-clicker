import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {writeFileSync,existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {createPythonRunner,runPython,PYTHON_STDIO_DRAIN_MS} from '../src/software-python.js';
import {persistedWriteOutcome} from '../src/write-outcome.js';
import {temp,until} from './helpers.mjs';

function harness(){
 let time=0,id=0,spawns=0;const timers=new Map(),signals=[];
 const schedule=(fn,ms)=>{const key=++id;timers.set(key,{fn,at:time+ms});return key;};
 const unschedule=key=>timers.delete(key);
 const advance=ms=>{const end=time+ms;for(;;){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;timers.delete(next[0]);next[1].fn();}time=end;};
 const child=new EventEmitter();Object.assign(child,{pid:123456,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:kind=>signals.push(['child',kind])});
 const runner=createPythonRunner({spawnProcess:()=>{spawns++;return child;},schedule,unschedule,killGroup:(pid,kind)=>{signals.push(['group',kind]);if(kind==='SIGKILL'&&signals.some(s=>s[1]==='SIGTERM'))return;throw Object.assign(new Error('empty group'),{code:'ESRCH'});},platform:'darwin'});
 return {runner,child,advance,signals,timers,get spawns(){return spawns}};
}

test('mock clock timeout/abort sends one TERM, bounded KILL and cannot settle before direct-child reap',async()=>{
 for(const cancelled of [false,true]){
  const h=harness(),controller=new AbortController();let settled=false;
  const waiting=h.runner({},[],{timeoutMs:100,cleanupGraceMs:20,signal:controller.signal}).finally(()=>{settled=true});const caught=waiting.catch(e=>e);
  if(cancelled)controller.abort();else h.advance(100);
  assert.equal(settled,false);assert.equal(h.signals.filter(s=>s[1]==='SIGTERM').length,2); // group attempt then direct fallback
  h.advance(19);assert.equal(settled,false);h.advance(1);assert(h.signals.some(s=>s[1]==='SIGKILL'));assert.equal(settled,false);
  h.child.emit('exit',null);h.child.emit('close',null);const error=await caught;assert.equal(error.code,cancelled?'PYTHON_CANCELLED':'PYTHON_TIMEOUT');assert.equal(h.timers.size,0);
 }
});

test('invalid timeout bounds and already-aborted signals never spawn a process',async()=>{
 const h=harness();for(const timeoutMs of [0,-1,Infinity,NaN,'1',true,3610001])await assert.rejects(h.runner({},[],{timeoutMs}),{code:'PYTHON_TIMEOUT_INVALID'});
 const c=new AbortController();c.abort(new Error('before-spawn'));await assert.rejects(h.runner({},[],{signal:c.signal}),/before-spawn/);assert.equal(h.spawns,0);
});

test('exit with inherited pipes has a separate bounded drain and never reports success',async()=>{
 const h=harness(),waiting=h.runner({},[],{timeoutMs:5000});const caught=waiting.catch(e=>e);h.child.emit('exit',0);
 h.advance(PYTHON_STDIO_DRAIN_MS-1);assert.equal(h.timers.size,1);h.advance(1);assert.equal((await caught).code,'PYTHON_STDIO_CLOSE_TIMEOUT');assert.equal(h.timers.size,0);
});

test('actual child timeout and cancellation wait for cooperative finally, with no second dispatch',async t=>{
 for(const cancel of [true,false]){
  const dir=temp(t),ready=path.join(dir,'ready'),clean=path.join(dir,'clean'),entry=path.join(dir,'child.cjs');
  writeFileSync(entry,`const fs=require('node:fs');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(clean)},'clean');process.exit(0)},30));fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},50);`);
  const c=new AbortController(),waiting=runPython({python:process.execPath},[entry],{signal:c.signal,timeoutMs:cancel?2000:250,cleanupGraceMs:300});const caught=waiting.catch(e=>e);
  await until(()=>existsSync(ready),2000);if(cancel)c.abort();const error=await caught;assert.equal(error.code,cancel?'PYTHON_CANCELLED':'PYTHON_TIMEOUT');assert(existsSync(clean));
 }
});

test('actual TERM-ignoring child is killed and reaped after a short explicit cleanup envelope',async t=>{
 const dir=temp(t),entry=path.join(dir,'ignore.cjs'),pidFile=path.join(dir,'pid');writeFileSync(entry,`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},50);`);
 const waiting=runPython({python:process.execPath},[entry],{timeoutMs:200,cleanupGraceMs:50});const caught=waiting.catch(e=>e);await until(()=>existsSync(pidFile),2000);const pid=Number(readFileSync(pidFile));assert.equal((await caught).code,'PYTHON_TIMEOUT');assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('actual success/nonzero/output tails preserve bounded output and exit outcome',async()=>{
 const success=await runPython({python:process.execPath},['-e',"process.stdout.write('X'.repeat(300000));process.stderr.write('S'.repeat(40000));"],{timeoutMs:2000});assert.equal(success.stdout.length,262144);assert.equal(success.stderr.length,32768);
 await assert.rejects(runPython({python:process.execPath},['-e',"process.stderr.write('nonzero-fixture');process.exit(3)"],{timeoutMs:2000}),/nonzero-fixture/);
});

test('actual remaining same-group descendant is killed and cannot turn its leader exit into success',{skip:process.platform==='win32'},async t=>{
 const dir=temp(t),entry=path.join(dir,'group.cjs'),receipt=path.join(dir,'pid');
 writeFileSync(entry,`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(receipt)},String(c.pid));c.unref();process.exit(0);`);
 await assert.rejects(runPython({python:process.execPath},[entry],{timeoutMs:2000}),{code:'PYTHON_DESCENDANTS_REMAINED'});
 const pid=Number(readFileSync(receipt));await until(()=>{try{return /^Z/.test(execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim())}catch{return true}},2000);
});

test('actual escaped-session inherited pipe is bounded, reported as failure and explicitly cleaned by its test owner',{skip:process.platform==='win32'},async t=>{
 const dir=temp(t),entry=path.join(dir,'pipe.cjs'),receipt=path.join(dir,'pid');
 writeFileSync(entry,`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:['ignore',1,2]});require('node:fs').writeFileSync(${JSON.stringify(receipt)},String(c.pid));c.unref();process.exit(0);`);
 try{await assert.rejects(runPython({python:process.execPath},[entry],{timeoutMs:2000}),{code:'PYTHON_STDIO_CLOSE_TIMEOUT'});}
 finally{if(existsSync(receipt)){const pid=Number(readFileSync(receipt));try{process.kill(-pid,'SIGKILL')}catch{}}}
});

test('forced termination cannot erase a previously persisted uncertain write or cause a retry',async t=>{
 const dir=temp(t),entry=path.join(dir,'intent.cjs'),intent=path.join(dir,'write-intent.json'),ready=path.join(dir,'ready');
 writeFileSync(entry,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(intent)},JSON.stringify({effect:'write',status:'unknown',automaticRetry:false}));fs.writeFileSync(${JSON.stringify(ready)},'dispatched-once');process.on('SIGTERM',()=>{});setInterval(()=>{},100);`);
 const waiting=runPython({python:process.execPath},[entry],{timeoutMs:200,cleanupGraceMs:30});const caught=waiting.catch(e=>e);await until(()=>existsSync(ready),2000);
 assert.equal((await caught).code,'PYTHON_TIMEOUT');assert.deepEqual(persistedWriteOutcome(dir),{status:'unknown',automaticRetry:false});assert.equal(readFileSync(ready,'utf8'),'dispatched-once');
});
