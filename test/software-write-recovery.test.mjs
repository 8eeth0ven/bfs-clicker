import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createSoftwareOperations} from '../src/software-operations.js';
import {persistedWriteOutcome} from '../src/write-outcome.js';

async function until(fn){for(let n=0;n<300;n++){const value=await fn();if(value)return value;await delay(10)}throw Error('write recovery fixture timeout')}
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'write-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,runtimeFile:path.join(root,'private-runtime.json')}}
function ownedFixtureWorker(mode,children){return(command,args,options)=>{
 const task=JSON.parse(readFileSync(args[1],'utf8'));
 const script=`const fs=require('node:fs'),path=require('node:path');const task=${JSON.stringify(task)};const out=task.outputDir;const write=(f,value)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(value))};write(path.join(out,'status.json'),{operationId:task.id,type:task.type,status:'running',pid:process.pid});const marker={effect:'write',status:'unknown',automaticRetry:false};${mode==='readonly'?'':mode==='samples'?"write(path.join(out,'workflow/sample-1/result.json'),{writeOutcome:{status:'observed',automaticRetry:false}});write(path.join(out,'workflow/sample-2/write-intent.json'),marker);":"write(path.join(out,'execution/write-intent.json'),marker);"}fs.appendFileSync(task.args.counter,'one-owned-effect\\n');${mode==='observed'?"write(path.join(out,'execution/result.json'),{writeOutcome:{status:'observed',automaticRetry:false}});process.exit(17);":mode==='readonly'?"process.exit(17);":"setInterval(()=>{},1000);"}`;
 const child=spawn(process.execPath,['-e',script],{...options,stdio:['ignore','pipe','pipe','ipc']});children.push(child);return child;
}}
for(const [type,mode]of [['execute','execution'],['bind-workflow','samples']])test(`killed ${type} retains unknown write outcome across manager restart and never auto retries`,async t=>{
 const runtime=await fixture(t),children=[],counter=path.join(runtime.root,'effect-count.txt'),manager=createSoftwareOperations(runtime,{spawnWorker:ownedFixtureWorker(mode,children)});t.after(()=>manager.shutdown());
 const started=manager.start(type,{counter});await until(()=>{try{return readFileSync(counter,'utf8').includes('one-owned-effect')}catch{return false}});assert.equal(children.length,1);children[0].kill('SIGKILL');
 const terminal=await until(()=>{const status=manager.status({operationId:started.operationId});return !status.active&&status.status!=='starting'&&status.status!=='running'&&status});
 assert.deepEqual(terminal.writeOutcome,{status:'unknown',automaticRetry:false});assert.equal(terminal.canResume,false);assert.throws(()=>manager.resume({operationId:started.operationId}),/只有探索/);
 const restarted=createSoftwareOperations(runtime);assert.deepEqual(restarted.status({operationId:started.operationId}).writeOutcome,{status:'unknown',automaticRetry:false});assert.equal(restarted.hasActive(),false);await delay(60);assert.equal((await readFile(counter,'utf8')).split('\n').filter(Boolean).length,1);assert.equal(children.length,1);await restarted.shutdown();
});
test('observed persisted result remains visible when owned worker exits after completing the write',async t=>{
 const runtime=await fixture(t),children=[],counter=path.join(runtime.root,'effect-count.txt'),manager=createSoftwareOperations(runtime,{spawnWorker:ownedFixtureWorker('observed',children)});t.after(()=>manager.shutdown());
 const started=manager.start('execute',{counter});const done=await until(()=>{const status=manager.status({operationId:started.operationId});return !status.active&&status.status==='failed'&&status});
 assert.deepEqual(done.writeOutcome,{status:'observed',automaticRetry:false});assert.equal(done.canResume,false);assert.equal((await readFile(counter,'utf8')).trim(),'one-owned-effect');
});
test('write outcome recovery ignores foreign symlinks and never follows arbitrary result paths',async t=>{
 const runtime=await fixture(t),foreign=await mkdtemp(path.join(os.tmpdir(),'write-recovery-foreign-'));t.after(()=>rm(foreign,{recursive:true,force:true}));await mkdir(path.join(runtime.root,'execution'));
 await writeFile(path.join(foreign,'write-intent.json'),JSON.stringify({effect:'write',status:'unknown',automaticRetry:false}));await symlink(path.join(foreign,'write-intent.json'),path.join(runtime.root,'execution/write-intent.json'));
 assert.equal(persistedWriteOutcome(runtime.root),undefined);
});


test('explicit unknown failure cannot be overwritten by an earlier observed learning sample',async t=>{
 const runtime=await fixture(t),children=[],counter=path.join(runtime.root,'effect-count.txt');
 const manager=createSoftwareOperations(runtime,{spawnWorker:(command,args,options)=>{const task=JSON.parse(readFileSync(args[1],'utf8'));const code=`const fs=require('node:fs'),path=require('node:path');const out=${JSON.stringify(task.outputDir)};fs.mkdirSync(path.join(out,'workflow/sample-1'),{recursive:true});fs.writeFileSync(path.join(out,'workflow/sample-1/result.json'),JSON.stringify({writeOutcome:{status:'observed',automaticRetry:false}}));fs.writeFileSync(path.join(out,'status.json'),JSON.stringify({operationId:${JSON.stringify(task.id)},type:'bind-workflow',status:'failed',writeOutcome:{status:'unknown',automaticRetry:false}}));`;const child=spawn(process.execPath,['-e',code],options);children.push(child);return child;}});t.after(()=>manager.shutdown());
 const job=manager.start('bind-workflow',{counter});const done=await until(()=>{const status=manager.status({operationId:job.operationId});return !status.active&&status.status==='failed'&&status});assert.deepEqual(done.writeOutcome,{status:'unknown',automaticRetry:false});assert.equal(children.length,1);
});
test('a task without persisted or explicit write evidence has no invented outcome',async t=>{
 const runtime=await fixture(t),children=[],manager=createSoftwareOperations(runtime,{spawnWorker:ownedFixtureWorker('readonly',children)});t.after(()=>manager.shutdown());const job=manager.start('compile',{counter:path.join(runtime.root,'instrumentation.txt')});
 const done=await until(()=>{const state=manager.status({operationId:job.operationId});return !state.active&&state.status==='failed'&&state});assert.equal(done.writeOutcome,undefined);assert.equal(persistedWriteOutcome(path.join(runtime.root,'operations',job.operationId)),undefined);
});
